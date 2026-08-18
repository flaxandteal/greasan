// SPDX-License-Identifier: AGPL-3.0-or-later
//! Gréasán's gramadan **Derive** provider — the `forms` nodegroup, generated on
//! demand from gramadan-rs, as a graph-attached function.
//!
//! Two layers:
//! - [`noun_forms`] — the PURE morphology core: `(lemma, gender, class) → forms`,
//!   a deterministic port of the noun path of `gramadan-wasm`'s paradigm builder,
//!   calling gramadan-rs. Independent of tiles/graph/concepts, so it is directly
//!   and thoroughly testable against real Irish nouns.
//! - [`GramadanForms`] — the `DeriveProvider`: read the entry's headword / gender
//!   / grammar-class from its tiles (resolving nodes by alias from the graph),
//!   run [`noun_forms`], and emit `forms` tiles (`written_rep` + `gram_features`
//!   concept ids + `form_dialect`). The concept ids come from a [`GramadanVocab`]
//!   the app builds from the loaded vocabulary at registration.

use std::collections::HashMap;
use std::sync::Arc;

use alizarin_core::{
    ComputeTilesConfig, DeriveProvider, FunctionsRegistry, GraphLookup, RegisteredFunction,
    StaticTile,
};
use gramadan::features::{Form, Gender};
use gramadan::noun::{
    generate_genitive, guess_declension, plural_paradigm, singular_paradigm, Declension,
};

/// Stable provider UUID — the `provider` value a `functions_x_graphs` compute-
/// tiles config references, and the key `register` inserts under.
pub const GRAMADAN_PROVIDER_ID: &str = "70000000-0000-0000-0000-000000000001";

/// One generated form + its BuNaMo-style axis tags (number, case). Matches the
/// tag vocabulary `paradigm.ts` pivots on and `build-bunamo-data.py` attests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GramForm {
    pub written_rep: String,
    pub tags: Vec<&'static str>,
}

fn decl_i8(d: Declension) -> i8 {
    match d {
        Declension::First => 1,
        Declension::Second => 2,
        Declension::Third => 3,
        Declension::Fourth => 4,
        Declension::Fifth => 5,
        Declension::Irregular => 0,
    }
}

fn push_forms(out: &mut Vec<GramForm>, forms: &[Form], number: &'static str, case: &'static str) {
    for f in forms {
        let v = f.value.trim();
        if v.is_empty() {
            continue;
        }
        out.push(GramForm {
            written_rep: v.to_string(),
            tags: vec![number, case],
        });
    }
}

/// The NOUN paradigm as `(form, tags)` pairs — pure and deterministic. `class` is
/// the declension `1..=5`; `0`/unknown is guessed from lemma+gender. Never empty:
/// the nominative singular always carries the headword (the table's anchor row).
pub fn noun_forms(lemma: &str, gender: Gender, class: i8) -> Vec<GramForm> {
    let decl: i8 = if (1..=5).contains(&class) {
        class
    } else {
        guess_declension(lemma, gender).map(decl_i8).unwrap_or(0)
    };

    let mut forms = Vec::new();
    match singular_paradigm(lemma, gender, decl) {
        Some(si) => {
            push_forms(&mut forms, &si.nominative, "singular", "nominative");
            push_forms(&mut forms, &si.genitive, "singular", "genitive");
            push_forms(&mut forms, &si.vocative, "singular", "vocative");
            push_forms(&mut forms, &si.dative, "singular", "dative");
        }
        None => {
            forms.push(GramForm {
                written_rep: lemma.to_string(),
                tags: vec!["singular", "nominative"],
            });
            if let Some(gen) = generate_genitive(lemma, gender, decl) {
                forms.push(GramForm {
                    written_rep: gen,
                    tags: vec!["singular", "genitive"],
                });
            }
        }
    }
    if !forms.iter().any(|f| f.tags == ["singular", "nominative"]) {
        forms.insert(
            0,
            GramForm {
                written_rep: lemma.to_string(),
                tags: vec!["singular", "nominative"],
            },
        );
    }
    if let Some(pi) = plural_paradigm(lemma, gender, decl) {
        push_forms(&mut forms, &pi.nominative, "plural", "nominative");
        push_forms(&mut forms, &pi.genitive, "plural", "genitive");
        push_forms(&mut forms, &pi.vocative, "plural", "vocative");
    }
    forms
}

/// Concept ids the provider needs to emit valid tiles. The app builds this from
/// the loaded vocabulary at registration (the same collections `build-bunamo-
/// data.py` maps against), so generated `gram_features` reference the SAME
/// concepts as attested BuNaMo forms and merge cleanly.
#[derive(Clone, Default)]
pub struct GramadanVocab {
    /// gram-feature tag ("singular"/"genitive"/…) → concept uuid.
    pub tag_concepts: HashMap<String, String>,
    /// gender concept uuid → is-feminine (else masculine).
    pub gender_is_fem: HashMap<String, bool>,
    /// the dialect concept uuid stamped on every generated form (e.g. Irish General).
    pub dialect_concept: String,
    /// the source tag stamped on every generated form (the computing layer's code,
    /// e.g. "gf") so the UI can attribute forms to their layer and tab per source.
    pub source_label: String,
}

/// The gramadan `DeriveProvider`.
pub struct GramadanForms {
    vocab: GramadanVocab,
}

impl GramadanForms {
    pub fn new(vocab: GramadanVocab) -> Self {
        Self { vocab }
    }
}

/// Register the gramadan provider under [`GRAMADAN_PROVIDER_ID`].
pub fn register(registry: &mut FunctionsRegistry, vocab: GramadanVocab) {
    registry.register(
        GRAMADAN_PROVIDER_ID,
        RegisteredFunction::Derive(Arc::new(GramadanForms::new(vocab))),
    );
}

/// Pull a scalar string out of a node value — tolerant of `"x"`,
/// `{"value":"x"}`, and localised `{"<lang>":{"value":"x"}}`.
fn str_value(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(s) = v.get("value").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    if let Some(obj) = v.as_object() {
        for inner in obj.values() {
            if let Some(s) = inner.get("value").and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Pull a concept uuid out of a concept node value — `"uuid"`,
/// `{"concept_id":"uuid"}`, or `{"value":"uuid"}`.
fn concept_id(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    for key in ["concept_id", "value"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

impl GramadanForms {
    /// nodeid for a node alias, from the graph. Resolved through [`GraphLookup`]
    /// so an overlay-defined node (a computed layer's own nodegroup) is visible.
    fn node_id(graph: &dyn GraphLookup, alias: &str) -> Option<String> {
        graph.get_node_by_alias(alias).map(|n| n.nodeid.clone())
    }

    /// The first scalar value of a node (by alias) across the resource's tiles.
    fn value_of(
        graph: &dyn GraphLookup,
        tiles: &[StaticTile],
        alias: &str,
    ) -> Option<serde_json::Value> {
        let id = Self::node_id(graph, alias)?;
        tiles.iter().find_map(|t| t.data.get(&id).cloned())
    }
}

impl DeriveProvider for GramadanForms {
    fn derive(
        &self,
        resource_id: &str,
        graph: &dyn GraphLookup,
        tiles: &[StaticTile],
        config: &ComputeTilesConfig,
    ) -> Result<Vec<StaticTile>, String> {
        // Inputs (by alias from the graph): headword (lemma), grammar_class,
        // gender (a concept id → masc/fem via the vocab).
        let lemma = Self::value_of(graph, tiles, "headword")
            .as_ref()
            .and_then(str_value)
            .ok_or("gramadan: no headword value")?;
        let class: i8 = Self::value_of(graph, tiles, "grammar_class")
            .as_ref()
            .and_then(str_value)
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        let fem = Self::value_of(graph, tiles, "gender")
            .as_ref()
            .and_then(concept_id)
            .and_then(|cid| self.vocab.gender_is_fem.get(&cid).copied())
            .unwrap_or(false);
        let gender = if fem { Gender::Fem } else { Gender::Masc };

        // Output node ids (by alias, within the forms nodegroup).
        let wr_id = Self::node_id(graph, "written_rep").ok_or("gramadan: no written_rep node")?;
        let gf_id = Self::node_id(graph, "gram_features");
        let dial_id = Self::node_id(graph, "form_dialect");
        let src_id = Self::node_id(graph, "form_source_label");

        let mut out = Vec::new();
        for (i, form) in noun_forms(&lemma, gender, class).into_iter().enumerate() {
            let mut data: HashMap<String, serde_json::Value> = HashMap::new();
            data.insert(wr_id.clone(), serde_json::json!({ "und": { "value": form.written_rep } }));
            // gram_features: the tags mapped to concept ids (skip tags with no
            // concept in the vocab rather than emit dangling ids).
            if let Some(gf) = &gf_id {
                let ids: Vec<String> = form
                    .tags
                    .iter()
                    .filter_map(|t| self.vocab.tag_concepts.get(*t).cloned())
                    .collect();
                if !ids.is_empty() {
                    data.insert(gf.clone(), serde_json::json!(ids));
                }
            }
            if let (Some(dial), false) = (&dial_id, self.vocab.dialect_concept.is_empty()) {
                data.insert(dial.clone(), serde_json::json!(self.vocab.dialect_concept));
            }
            // Source tag: attributes every generated form to the computing layer,
            // so the UI can render one paradigm tab per contributing source.
            if let (Some(src), false) = (&src_id, self.vocab.source_label.is_empty()) {
                data.insert(
                    src.clone(),
                    serde_json::json!({ "und": { "value": self.vocab.source_label } }),
                );
            }
            out.push(StaticTile {
                data,
                nodegroup_id: config.nodegroup.clone(),
                resourceinstance_id: resource_id.to_string(),
                // A DISTINCT tile id per generated form. Without it every form
                // tile shares `None`, and the cardinality-n merge collapses them
                // all into the first (the paradigm renders as one repeated cell).
                // Deterministic (resource + nodegroup + index) so repeat hydrations
                // are stable and de-dupe cleanly.
                tileid: Some(format!("{resource_id}:{}:gf:{i}", config.nodegroup)),
                parenttile_id: None,
                provisionaledits: None,
                sortorder: Some(i as i32),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests;

// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use alizarin_core::StaticGraph;

const NUMBERS: [&str; 2] = ["singular", "plural"];
const CASES: [&str; 4] = ["nominative", "genitive", "vocative", "dative"];

fn has(forms: &[GramForm], number: &str, case: &str, written: &str) -> bool {
    forms
        .iter()
        .any(|f| f.tags == [number, case] && f.written_rep == written)
}

// ---- pure morphology core: noun_forms --------------------------------------

#[test]
fn noun_forms_are_never_empty_and_anchor_on_the_headword() {
    // Anchor invariant: whatever gramadan-rs does, the nom sg carries the lemma.
    for (lemma, gender, class) in [
        ("fear", Gender::Masc, 1),
        ("bord", Gender::Masc, 1),
        ("bróg", Gender::Fem, 2),
        ("madra", Gender::Masc, 4),
        ("xyzzyq", Gender::Masc, 0), // nonsense → guessed → still anchored
    ] {
        let forms = noun_forms(lemma, gender, class);
        assert!(!forms.is_empty(), "{lemma}: forms must not be empty");
        assert!(
            has(&forms, "singular", "nominative", lemma),
            "{lemma}: nom sg must carry the headword"
        );
    }
}

#[test]
fn noun_forms_only_use_valid_axis_tags() {
    let forms = noun_forms("fear", Gender::Masc, 1);
    for f in &forms {
        assert_eq!(f.tags.len(), 2, "tags are [number, case]: {:?}", f.tags);
        assert!(NUMBERS.contains(&f.tags[0]), "bad number tag {:?}", f.tags);
        assert!(CASES.contains(&f.tags[1]), "bad case tag {:?}", f.tags);
        assert!(!f.written_rep.trim().is_empty(), "no blank forms");
    }
}

#[test]
fn regular_masc_decl1_declines_fear() {
    // Textbook 1st-declension masculine: fear → fir (gen sg, nom pl), fear (gen pl).
    let forms = noun_forms("fear", Gender::Masc, 1);
    assert!(has(&forms, "singular", "nominative", "fear"));
    assert!(
        has(&forms, "singular", "genitive", "fir"),
        "gen sg of fear is fir; got {forms:?}"
    );
    assert!(
        has(&forms, "plural", "nominative", "fir"),
        "nom pl of fear is fir; got {forms:?}"
    );
}

#[test]
fn a_genitive_singular_is_always_produced_for_a_regular_noun() {
    let forms = noun_forms("bord", Gender::Masc, 1);
    assert!(
        forms.iter().any(|f| f.tags == ["singular", "genitive"]),
        "bord must have a genitive singular; got {forms:?}"
    );
}

#[test]
fn class_zero_is_guessed_not_rejected() {
    // Unknown class → guessed; still a usable paradigm (not just the anchor).
    let forms = noun_forms("cat", Gender::Masc, 0);
    assert!(has(&forms, "singular", "nominative", "cat"));
    assert!(forms.len() >= 2, "guessed paradigm should add at least a genitive");
}

#[test]
fn determinism() {
    assert_eq!(noun_forms("fear", Gender::Masc, 1), noun_forms("fear", Gender::Masc, 1));
}

// ---- the DeriveProvider: tiles + graph → forms tiles -----------------------

fn fixture_graph() -> StaticGraph {
    // Minimal lexical-entry-shaped graph: the input nodes (headword/grammar_class/
    // gender) + the forms nodegroup children (written_rep/gram_features/
    // form_dialect), each with the alias the provider resolves by.
    serde_json::from_value(serde_json::json!({
        "graphid": "le",
        "name": {"en": "LexicalEntry"},
        "root": {"nodeid": "root", "name": "Root", "datatype": "semantic", "graph_id": "le"},
        "nodes": [
            {"nodeid": "root", "name": "Root", "datatype": "semantic", "graph_id": "le"},
            {"nodeid": "n-hw", "name": "Headword", "datatype": "string", "graph_id": "le", "alias": "headword"},
            {"nodeid": "n-gc", "name": "Class", "datatype": "string", "graph_id": "le", "alias": "grammar_class"},
            {"nodeid": "n-gen", "name": "Gender", "datatype": "concept", "graph_id": "le", "alias": "gender"},
            {"nodeid": "n-wr", "name": "Written", "datatype": "string", "graph_id": "le", "alias": "written_rep", "nodegroup_id": "forms-ng"},
            {"nodeid": "n-gf", "name": "Features", "datatype": "concept-list", "graph_id": "le", "alias": "gram_features", "nodegroup_id": "forms-ng"},
            {"nodeid": "n-dl", "name": "Dialect", "datatype": "concept", "graph_id": "le", "alias": "form_dialect", "nodegroup_id": "forms-ng"}
        ],
        "edges": [], "nodegroups": [], "cards": [], "cards_x_nodes_x_widgets": [],
        "functions_x_graphs": []
    }))
    .expect("fixture graph")
}

fn vocab() -> GramadanVocab {
    let mut tag_concepts = std::collections::HashMap::new();
    for (tag, cid) in [
        ("singular", "c-sg"),
        ("plural", "c-pl"),
        ("nominative", "c-nom"),
        ("genitive", "c-gen"),
        ("vocative", "c-voc"),
        ("dative", "c-dat"),
    ] {
        tag_concepts.insert(tag.to_string(), cid.to_string());
    }
    GramadanVocab {
        tag_concepts,
        gender_is_fem: [("gender-fem".to_string(), true)].into_iter().collect(),
        dialect_concept: "dialect-irish".to_string(),
    }
}

fn config() -> ComputeTilesConfig {
    // forms nodegroup id = "forms-ng"; provider key + membership immaterial here.
    serde_json::from_value(serde_json::json!({
        "provider": GRAMADAN_PROVIDER_ID,
        "nodegroup": "forms-ng",
        "member_of": "gramadan",
        "cache": true
    }))
    .expect("config")
}

fn input_tile(data: serde_json::Value) -> StaticTile {
    let map = data
        .as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    StaticTile {
        data: map,
        nodegroup_id: "entry-ng".to_string(),
        resourceinstance_id: "r1".to_string(),
        tileid: None,
        parenttile_id: None,
        provisionaledits: None,
        sortorder: None,
    }
}

#[test]
fn provider_reads_the_entry_and_emits_forms_tiles() {
    let provider = GramadanForms::new(vocab());
    let graph = fixture_graph();
    // A masculine 1st-declension entry: "fear", class 1.
    let tiles = vec![
        input_tile(serde_json::json!({ "n-hw": { "und": { "value": "fear" } } })),
        input_tile(serde_json::json!({ "n-gc": { "value": "1" } })),
    ];

    let out = provider
        .derive("r1", &graph, &tiles, &config())
        .expect("derive");

    assert!(!out.is_empty(), "forms tiles produced");
    // Every emitted tile is a forms-nodegroup tile for this resource, carrying a
    // written_rep and gram_features concept ids.
    for t in &out {
        assert_eq!(t.nodegroup_id, "forms-ng");
        assert_eq!(t.resourceinstance_id, "r1");
        assert!(t.data.contains_key("n-wr"), "written_rep present");
        let wr = t.data["n-wr"]["und"]["value"].as_str().unwrap_or("");
        assert!(!wr.is_empty());
        let gf = t.data["n-gf"].as_array().expect("gram_features is a list");
        assert!(!gf.is_empty(), "gram_features mapped to concept ids");
        // ids come from the vocab (c-sg / c-nom / …), never raw tag labels.
        for id in gf {
            assert!(id.as_str().unwrap().starts_with("c-"), "concept id, not a label: {id}");
        }
        assert_eq!(t.data["n-dl"].as_str(), Some("dialect-irish"));
    }

    // The nominative singular tile carries the headword.
    let nom_sg_written: Vec<_> = out
        .iter()
        .filter(|t| {
            let gf = t.data["n-gf"].as_array().unwrap();
            gf.iter().any(|c| c == "c-sg") && gf.iter().any(|c| c == "c-nom")
        })
        .filter_map(|t| t.data["n-wr"]["und"]["value"].as_str())
        .collect();
    assert!(nom_sg_written.contains(&"fear"), "nom sg tile carries the headword; got {nom_sg_written:?}");
}

#[test]
fn provider_errors_without_a_headword() {
    let provider = GramadanForms::new(vocab());
    let graph = fixture_graph();
    let tiles = vec![input_tile(serde_json::json!({ "n-gc": { "value": "1" } }))];
    assert!(provider.derive("r1", &graph, &tiles, &config()).is_err());
}

#[test]
fn provider_registers_under_the_stable_uuid() {
    let mut reg = FunctionsRegistry::new();
    register(&mut reg, vocab());
    assert!(reg.derive(GRAMADAN_PROVIDER_ID).is_some());
}

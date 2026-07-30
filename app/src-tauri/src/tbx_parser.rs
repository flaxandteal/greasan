// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Flax & Teal Limited

//! Parse Téarma.ie TBX XML into business-data CSV suitable for
//! `alizarin_core::build_resources_from_business_csv`.
//!
//! Ported from `src/goidelic/tbx.py`, `ontolex.py`, and `arches.py`.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// POS mapping (Téarma uses English abbreviations and Irish grammatical labels)
// ---------------------------------------------------------------------------

fn map_pos(raw: &str) -> &'static str {
    match raw.trim() {
        "s" => "noun",
        "v" => "verb",
        "a" => "adjective",
        "properNoun" => "proper noun",
        "abbr" | "gior" | "abr" => "noun",
        "phr." => "phrase",
        "pref" | "réimír" => "prefix",
        "fir" | "fir1" | "fir2" | "fir3" | "fir4" | "fir5" => "noun",
        "bain" | "bain2" | "bain3" | "bain4" | "bain5" => "noun",
        "iol" | "pl" | "s pl" => "noun",
        "br" => "verb",
        "a1" | "a2" | "a3" | "gu mar a" => "adjective",
        "frása" => "phrase",
        _ => "noun",
    }
}

fn extract_gender(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "fir" | "fir1" | "fir2" | "fir3" | "fir4" | "fir5" => Some("masculine"),
        "bain" | "bain2" | "bain3" | "bain4" | "bain5" => Some("feminine"),
        "iol" | "pl" | "s pl" => Some("plural"),
        _ => None,
    }
}

/// The declension class encoded in the Téarma POS code. Téarma states the
/// declension in the gender abbreviation itself — `fir1`..`fir5` (masculine
/// noun) and `bain2`..`bain5` (feminine noun), plus `a1`..`a3` for adjective
/// declension. The trailing digit IS the class, so we keep it as `grammar_class`
/// (`goidelic#grammaticalClass`, same node BuNaMo populates) rather than
/// discarding it and later re-guessing from lemma+gender. Bare `fir`/`bain`
/// (no digit) carry no class → None.
fn extract_declension(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "fir1" | "a1" => Some("1"),
        "fir2" | "bain2" | "a2" => Some("2"),
        "fir3" | "bain3" | "a3" => Some("3"),
        "fir4" | "bain4" => Some("4"),
        "fir5" | "bain5" => Some("5"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Domain mapping (Téarma subject fields → UNESCO Thesaurus labels)
// ---------------------------------------------------------------------------

fn domain_lookup(s: &str) -> Option<&'static str> {
    match s {
        "Agriculture, Fishing" => Some("Agriculture"),
        "Archaeology" | "History" => Some("History"),
        "Architecture" => Some("Architecture"),
        "Art" | "Arts, Crafts" => Some("Art"),
        "Biology" => Some("Biology"),
        "Business" => Some("Trade"),
        "Chemistry" => Some("Chemistry"),
        "Computers, Computer Science" => Some("Information technology"),
        "Dancing" | "Music" => Some("Performing arts"),
        "Economics" => Some("Economics"),
        "Education" => Some("Education"),
        "Electricity, Electronics" => Some("Energy"),
        "Engineering" | "Technical Drawing" => Some("Engineering"),
        "Environment & Ecology" | "Environment &amp; Ecology" => Some("Environment"),
        "Fashion" => Some("Textile industry"),
        "Finance" => Some("Financial management"),
        "Geography" => Some("Geography"),
        "Government" => Some("Government"),
        "Health" | "Safety" => Some("Health"),
        "Industry" | "Trades, Crafts" => Some("Industry"),
        "Law" | "Policing" => Some("Legal systems"),
        "Leisure" | "Sports" => Some("Leisure"),
        "Librarianship" => Some("Library science"),
        "Literature" => Some("Linguistics"),
        "Mathematics" | "Natural Sciences & Mathematics"
        | "Natural Sciences &amp; Mathematics" => Some("Mathematics"),
        "Media" => Some("Communication"),
        "Medicine, Medical" => Some("Medical sciences"),
        "Military" => Some("Defence"),
        "Nautical" | "Transport" => Some("Transport"),
        "Organisation" => Some("Public administration"),
        "Physics" => Some("Physics"),
        "Politics" => Some("Political science"),
        "Publishing" => Some("Printing"),
        "Religion" => Some("Religion"),
        "Social Science" => Some("Social sciences"),
        "Tourism" => Some("Tourism"),
        "Veterinary science" => Some("Veterinary medicine"),
        "Zoology" => Some("Zoology"),
        "Calendar" => Some("Calendar"),
        "Colours" => Some("Colours"),
        "Culinary" => Some("Culinary arts"),
        "Home Economics" => Some("Home economics"),
        "Names" | "Nationalities and Peoples" | "Placenames" => Some("Names"),
        "Signage" => Some("Signage"),
        _ => None,
    }
}

fn clean_domain(text: &str) -> String {
    let mut result = text.to_string();
    while result.contains("&amp;") {
        result = result.replace("&amp;", "&");
    }
    result.trim().to_string()
}

fn map_domains(raw_domains: &[String]) -> Vec<String> {
    let mut mapped: Vec<String> = Vec::new();
    for domain in raw_domains {
        if domain.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let cleaned = clean_domain(domain);
        // Try exact match
        let label = domain_lookup(&cleaned).or_else(|| {
            // Try top-level (before first »)
            cleaned
                .split('»')
                .next()
                .map(|b| b.trim())
                .filter(|b| *b != cleaned.as_str())
                .and_then(domain_lookup)
        });
        if let Some(l) = label {
            let l = l.to_string();
            if !mapped.contains(&l) {
                mapped.push(l);
            }
        }
    }
    mapped
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Sense {
    pub gloss: String,
    pub example: String,
}

#[derive(Debug, Clone)]
pub struct Form {
    pub written_rep: String,
    pub gram_features: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TbxRecord {
    pub word: String,
    pub pos: String,
    /// Declension/conjugation class from the POS code ("1".."5"), or empty when
    /// the source gives none. See {@link extract_declension}.
    pub grammar_class: String,
    /// Confidence of `grammar_class`: "attested" (explicit TBX code), or
    /// "inferred"/"uncertain" once `enrich_records` fills a classless entry via
    /// gramadan morphology; empty when there is no class. Drives the UI '?'.
    pub grammar_class_confidence: String,
    pub dialect: String,
    pub senses: Vec<Sense>,
    pub forms: Vec<Form>,
    pub categories: Vec<String>,
}

// ---------------------------------------------------------------------------
// Intermediate parse types (used during XML walking)
// ---------------------------------------------------------------------------

struct LangSetData {
    lang: String,
    definitions: Vec<String>,
    examples: Vec<String>,
    term_groups: Vec<TermGroupData>,
}

struct TermGroupData {
    headword: String,
    raw_pos: String,
    norm_auth: String,
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

/// Parse TBX XML bytes into merged, deduplicated records.
pub fn parse_tbx(bytes: &[u8]) -> Result<Vec<TbxRecord>, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| format!("invalid UTF-8: {e}"))?;
    let all_records = parse_tbx_entries(text)?;
    Ok(merge_duplicates(all_records))
}

/// Parse the XML text into raw (unmerged) records.
fn parse_tbx_entries(xml_text: &str) -> Result<Vec<TbxRecord>, String> {
    let mut records = Vec::new();
    let mut reader = Reader::from_str(xml_text);
    reader.config_mut().trim_text(true);

    let mut depth = 0u32;
    let mut in_term_entry = false;
    let mut entry_xml = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                if e.local_name().as_ref() == b"termEntry" {
                    in_term_entry = true;
                    depth = 1;
                    entry_xml.clear();
                    entry_xml.push_str("<termEntry");
                    for attr in e.attributes().flatten() {
                        let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let val = attr.unescape_value().unwrap_or_default();
                        entry_xml.push(' ');
                        entry_xml.push_str(key);
                        entry_xml.push_str("=\"");
                        entry_xml.push_str(&val);
                        entry_xml.push('"');
                    }
                    entry_xml.push('>');
                } else if in_term_entry {
                    depth += 1;
                    let local = e.local_name();
                    let name = std::str::from_utf8(local.as_ref()).unwrap_or("");
                    entry_xml.push('<');
                    entry_xml.push_str(name);
                    for attr in e.attributes().flatten() {
                        let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let val = attr.unescape_value().unwrap_or_default();
                        entry_xml.push(' ');
                        entry_xml.push_str(key);
                        entry_xml.push_str("=\"");
                        entry_xml.push_str(&val);
                        entry_xml.push('"');
                    }
                    entry_xml.push('>');
                }
            }
            Ok(Event::End(ref e)) => {
                if in_term_entry {
                    let local = e.local_name();
                    let name = std::str::from_utf8(local.as_ref()).unwrap_or("");
                    entry_xml.push_str("</");
                    entry_xml.push_str(name);
                    entry_xml.push('>');
                    depth -= 1;
                    if depth == 0 {
                        in_term_entry = false;
                        if let Ok(mut recs) = parse_single_entry(&entry_xml) {
                            records.append(&mut recs);
                        }
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                if in_term_entry {
                    let local = e.local_name();
                    let name = std::str::from_utf8(local.as_ref()).unwrap_or("");
                    entry_xml.push('<');
                    entry_xml.push_str(name);
                    for attr in e.attributes().flatten() {
                        let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let val = attr.unescape_value().unwrap_or_default();
                        entry_xml.push(' ');
                        entry_xml.push_str(key);
                        entry_xml.push_str("=\"");
                        entry_xml.push_str(&val);
                        entry_xml.push('"');
                    }
                    entry_xml.push_str("/>");
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_term_entry {
                    let text = e.unescape().unwrap_or_default();
                    entry_xml.push_str(&quick_xml::escape::escape(text.as_ref()));
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
    }

    Ok(records)
}

/// Parse a single `<termEntry>` XML fragment into records.
fn parse_single_entry(xml: &str) -> Result<Vec<TbxRecord>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut raw_domains: Vec<String> = Vec::new();
    let mut lang_sets: Vec<LangSetData> = Vec::new();
    let mut current_lang_set: Option<LangSetData> = None;
    let mut current_term_group: Option<TermGroupData> = None;
    let mut current_attr_type = String::new();
    let mut current_text = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                current_text.clear();
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref()).unwrap_or("").to_string();
                let type_attr = e
                    .attributes()
                    .flatten()
                    .find(|a| a.key.as_ref() == b"type")
                    .and_then(|a| a.unescape_value().ok())
                    .map(|v| v.to_string())
                    .unwrap_or_default();

                match name.as_str() {
                    "langSet" => {
                        let lang = e
                            .attributes()
                            .flatten()
                            .find(|a| a.key.as_ref() == b"xml:lang")
                            .and_then(|a| a.unescape_value().ok())
                            .map(|v| v.to_string())
                            .unwrap_or_default();
                        current_lang_set = Some(LangSetData {
                            lang,
                            definitions: Vec::new(),
                            examples: Vec::new(),
                            term_groups: Vec::new(),
                        });
                    }
                    "ntig" | "tig" => {
                        current_term_group = Some(TermGroupData {
                            headword: String::new(),
                            raw_pos: String::new(),
                            norm_auth: String::new(),
                        });
                    }
                    "descrip" | "termNote" => {
                        current_attr_type = type_attr;
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref()).unwrap_or("").to_string();
                let text = current_text.trim().to_string();

                match name.as_str() {
                    "descrip" => {
                        if !text.is_empty() {
                            if current_lang_set.is_some() && current_term_group.is_none() {
                                let ls = current_lang_set.as_mut().unwrap();
                                match current_attr_type.as_str() {
                                    "definition" => ls.definitions.push(text),
                                    "example" => ls.examples.push(text),
                                    _ => {}
                                }
                            } else if current_lang_set.is_none()
                                && current_attr_type == "subjectField"
                            {
                                raw_domains.push(text);
                            }
                        }
                        current_attr_type.clear();
                    }
                    "term" => {
                        if let Some(ref mut tg) = current_term_group {
                            tg.headword = text.trim().to_string();
                        }
                    }
                    "termNote" => {
                        if let Some(ref mut tg) = current_term_group {
                            match current_attr_type.as_str() {
                                "partOfSpeech" if tg.raw_pos.is_empty() => {
                                    tg.raw_pos = text;
                                }
                                "normativeAuthorization" => {
                                    tg.norm_auth = text;
                                }
                                _ => {}
                            }
                        }
                        current_attr_type.clear();
                    }
                    "ntig" | "tig" => {
                        if let Some(tg) = current_term_group.take() {
                            if let Some(ref mut ls) = current_lang_set {
                                ls.term_groups.push(tg);
                            }
                        }
                    }
                    "langSet" => {
                        if let Some(ls) = current_lang_set.take() {
                            lang_sets.push(ls);
                        }
                    }
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Text(ref e)) => {
                let t = e.unescape().unwrap_or_default();
                current_text.push_str(&t);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("entry parse error: {e}")),
            _ => {}
        }
    }

    // Find English gloss from en langSet
    let en_gloss = {
        let mut gloss = String::new();
        for ls in &lang_sets {
            if ls.lang != "en" {
                continue;
            }
            if let Some(def) = ls.definitions.first() {
                gloss = def.clone();
            } else {
                // Fall back to English term text
                for tg in &ls.term_groups {
                    if !tg.headword.is_empty() {
                        gloss = tg.headword.clone();
                        break;
                    }
                }
            }
            break;
        }
        gloss
    };

    let mapped_domains = map_domains(&raw_domains);
    let mut records = Vec::new();

    for ls in &lang_sets {
        if ls.lang != "ga" {
            continue;
        }
        for tg in &ls.term_groups {
            if tg.norm_auth == "dímholta" || tg.headword.is_empty() {
                continue;
            }

            let pos = if tg.raw_pos.is_empty() {
                "noun"
            } else {
                map_pos(&tg.raw_pos)
            };
            let gender = if tg.raw_pos.is_empty() {
                None
            } else {
                extract_gender(&tg.raw_pos)
            };

            let gloss = if !en_gloss.is_empty() {
                en_gloss.clone()
            } else if let Some(def) = ls.definitions.first() {
                def.clone()
            } else {
                tg.headword.clone()
            };

            let mut senses = vec![Sense {
                gloss: gloss.clone(),
                example: ls.examples.first().cloned().unwrap_or_default(),
            }];
            let skip_first = ls.definitions.first().map_or(false, |d| *d == gloss);
            for def in ls.definitions.iter().skip(if skip_first { 1 } else { 0 }) {
                if *def != gloss {
                    senses.push(Sense {
                        gloss: def.clone(),
                        example: String::new(),
                    });
                }
            }

            let forms = match gender {
                Some(g) => vec![Form {
                    written_rep: tg.headword.clone(),
                    gram_features: vec![g.to_string()],
                }],
                None => Vec::new(),
            };

            // Noun/adjective declension is STATED in the POS code, so we extract
            // it. Verb conjugation is NOT stated by Téarma and is left empty here
            // — inferring it (and guessing the bare-fir/bain noun gap) is the
            // separate grammar-class-inference session's job. See the hand-off.
            let grammar_class = if tg.raw_pos.is_empty() {
                String::new()
            } else {
                extract_declension(&tg.raw_pos).unwrap_or("").to_string()
            };

            records.push(TbxRecord {
                word: tg.headword.clone(),
                pos: pos.to_string(),
                grammar_class,
                // Stamped by `enrich_records` (attested if class present, else the
                // gramadan method's confidence, else empty).
                grammar_class_confidence: String::new(),
                dialect: "Irish (General)".to_string(),
                senses,
                forms,
                categories: mapped_domains.clone(),
            });
        }
    }

    Ok(records)
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

fn merge_duplicates(records: Vec<TbxRecord>) -> Vec<TbxRecord> {
    let mut grouped: HashMap<(String, String), TbxRecord> = HashMap::new();
    let mut order: Vec<(String, String)> = Vec::new();

    for rec in records {
        let key = (rec.word.clone(), rec.pos.clone());
        if let Some(existing) = grouped.get_mut(&key) {
            let existing_glosses: HashSet<String> =
                existing.senses.iter().map(|s| s.gloss.clone()).collect();
            for sense in &rec.senses {
                if !existing_glosses.contains(&sense.gloss) {
                    existing.senses.push(sense.clone());
                }
            }
            for cat in &rec.categories {
                if !existing.categories.contains(cat) {
                    existing.categories.push(cat.clone());
                }
            }
        } else {
            order.push(key.clone());
            grouped.insert(key, rec);
        }
    }

    order
        .into_iter()
        .filter_map(|k| grouped.remove(&k))
        .collect()
}

// ---------------------------------------------------------------------------
// Slugify (from ontolex.py)
// ---------------------------------------------------------------------------

fn slugify(word: &str, pos: &str, lang_code: &str) -> String {
    let mut slug = word.to_lowercase();
    slug = slug.split_whitespace().collect::<Vec<_>>().join("-");
    slug.retain(|c| c.is_alphanumeric() || c == '-' || c == '_' || "áéíóúàèìòù".contains(c));
    if lang_code.is_empty() {
        format!("{slug}-{pos}")
    } else {
        format!("{lang_code}-{slug}-{pos}")
    }
}

// ---------------------------------------------------------------------------
// CSV generation (from arches.py)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: &[&str] = &[
    "ResourceID",
    "headword",
    "part_of_speech",
    "dialect",
    "ipa_value",
    "gloss",
    "example",
    "source_label",
    "written_rep",
    "gram_features",
    "domain",
    "etymology_text",
    "etymology_source",
    "cognate_headword",
    "cognate_language",
    "cognate_entry_id",
    "related_entries",
    // Appended last so the positional row writes below stay put. Matches the
    // `grammar_class` node on the lexical_entry model (BuNaMo emits it too).
    "grammar_class",
    // The confidence concept sits in the same `grammar_class_group` nodegroup.
    "grammar_class_confidence",
];

/// Map a gramadan resolution [`Method`] to a confidence concept, mirroring the
/// Python `tbx.py` `_METHOD_CONFIDENCE`.
fn method_confidence(m: gramadan::enrich::Method) -> &'static str {
    use gramadan::enrich::Method::*;
    match m {
        AlreadyStated | DbLookup => "attested",
        HeuristicVowel4th | HeuristicVnAdh | HeuristicVnAil | HeuristicProper4th
        | CompoundDecomposition => "inferred",
        MorphologicalGuesser | VerbHeuristic => "uncertain",
        Unresolved => "",
    }
}

/// Fill `grammar_class` for classless noun/verb records via gramadan morphology
/// (empty `LemmaDb` — heuristics + baked exception lists suffice; gramadan
/// hand-off §1b) and stamp `grammar_class_confidence`. The on-device counterpart
/// of the Python `tbx.py` enrichment, so a phone-built Téarma matches the shipped
/// corpus (~80% of classless nouns/verbs resolved). A class already given by the
/// TBX POS code is marked "attested".
pub fn enrich_records(records: &mut [TbxRecord]) {
    use gramadan::enrich::{enrich_grammar_class, Record as GRecord};
    use gramadan::noun::LemmaDb;
    let db = LemmaDb::new();
    for rec in records.iter_mut() {
        if !rec.grammar_class.is_empty() {
            rec.grammar_class_confidence = "attested".to_string();
            continue;
        }
        if rec.pos != "noun" && rec.pos != "verb" {
            continue;
        }
        // Gender rides the first form's gram_features (see `extract_gender`).
        let gender = rec
            .forms
            .first()
            .and_then(|f| f.gram_features.first().cloned())
            .unwrap_or_default();
        let res = enrich_grammar_class(
            &GRecord {
                word: rec.word.clone(),
                pos: rec.pos.clone(),
                gender,
                grammar_class: String::new(),
            },
            &db,
        );
        if !res.grammar_class.is_empty() {
            rec.grammar_class = res.grammar_class;
            rec.grammar_class_confidence = method_confidence(res.method).to_string();
        }
    }
}

/// Convert parsed TBX records into business-data CSV.
pub fn records_to_csv(records: &[TbxRecord], source_label: &str) -> Result<String, String> {
    let mut out = String::new();
    out.push_str(&CSV_COLUMNS.join(","));
    out.push('\n');

    let mut seen_ids: HashMap<String, u32> = HashMap::new();

    for rec in records {
        let base_id = slugify(&rec.word, &rec.pos, "ga");
        let rid = match seen_ids.get(&base_id) {
            Some(&count) => {
                let next = count + 1;
                seen_ids.insert(base_id.clone(), next);
                format!("{base_id}-{next}")
            }
            None => {
                seen_ids.insert(base_id.clone(), 1);
                base_id
            }
        };

        let max_rows = rec.senses.len().max(rec.forms.len()).max(1);

        for i in 0..max_rows {
            let mut row = vec![String::new(); CSV_COLUMNS.len()];
            row[0] = rid.clone();

            if i == 0 {
                row[1] = csv_escape(&rec.word);
                row[2] = csv_escape(&rec.pos);
                row[3] = csv_escape(&rec.dialect);
                if !rec.categories.is_empty() {
                    row[10] = csv_escape(&rec.categories.join("|"));
                }
                // grammar_class + its confidence are the two appended final
                // columns (in CSV_COLUMNS order).
                let n = CSV_COLUMNS.len();
                row[n - 2] = csv_escape(&rec.grammar_class);
                row[n - 1] = csv_escape(&rec.grammar_class_confidence);
            }

            if i < rec.senses.len() {
                row[5] = csv_escape(&rec.senses[i].gloss);
                row[6] = csv_escape(&rec.senses[i].example);
                row[7] = csv_escape(source_label);
            }

            if i < rec.forms.len() {
                row[8] = csv_escape(&rec.forms[i].written_rep);
                row[9] = csv_escape(&rec.forms[i].gram_features.join(", "));
            }

            out.push_str(&row.join(","));
            out.push('\n');
        }
    }

    Ok(out)
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('\n') || s.contains('"') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

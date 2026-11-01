// Spot-check: how does gramadán conjugate the Téarma verb "middle category"
// (single-word br/v NOT in BuNaMo)? Prints the realised past/future/conditional
// base + verbal noun for a categorised sample, so we can eyeball regular vs
// prefixed vs junk. A known-good control confirms the probe itself.
//
//   cargo run --release --example verb-probe

use gramadan::verb::{guess_conjugation, Verb, VerbPerson, VerbTense};

fn row(lemma: &str) {
    let cls = guess_conjugation(lemma);
    let v = Verb::from_lemma(lemma, cls);
    let a = |t: VerbTense| v.shape_a(t, VerbPerson::Base).unwrap_or_else(|| "-".into());
    let vn = v.verbal_noun.first().map(|f| f.value.as_str()).unwrap_or("-");
    println!(
        "  {lemma:<18} class={cls:?}  past={:<16} fut={:<18} cond={:<18} vn={vn}",
        a(VerbTense::Past),
        a(VerbTense::Fut),
        a(VerbTense::Cond),
    );
}

fn main() {
    let groups: &[(&str, &[&str])] = &[
        ("CONTROL (in BuNaMo - should be right)", &["gearr", "mionnaigh", "ceannaigh"]),
        ("regular -igh (middle)", &["acmhainnigh", "adhmadaigh", "aerthriomaigh", "airpéitsigh"]),
        ("regular -áil (middle)", &["aischrosáil", "ais-suiteáil"]),
        ("prefixed, non-hyphen (middle, risky)", &["aisfhill", "aisfheistigh", "róshealbhaigh", "aimhriar"]),
        ("hyphenated (middle, very risky)", &["ais-haiceáil", "x-ghathaigh"]),
        ("capitalised denominal (middle)", &["Ioslamaigh", "Uathshuimigh"]),
    ];
    for (title, ls) in groups {
        println!("\n== {title} ==");
        for l in *ls {
            row(l);
        }
    }
}

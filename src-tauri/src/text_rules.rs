//! Text rules: find → replace rules the user edits in Settings, applied to
//! dictated text right before the transcription hook and the paste. History
//! keeps the text from before the rules, so the user can see what to match.
//!
//! Built for speech models that write spoken punctuation as tokens, such as
//! `{period}` or `{comma}`, and add punctuation of their own:
//!
//! - Every rule is applied to the original text in one pass, so rules never
//!   act on each other's output. `,` → delete and `{comma}` → `,` work
//!   together in any order. Where two rules match at the same place, the
//!   longer find text wins.
//! - Find text matches regardless of case, and spaces inside `{…}` don't
//!   matter: `{ Comma }` matches `{comma}`. Other runs of spaces match any
//!   run of whitespace. Find text that starts or ends with a letter or digit
//!   matches whole words only, so a `period` rule leaves "periodic" alone.
//! - A punctuation mark with a digit directly on both sides is never
//!   changed, so `.` → delete keeps `2.5 cm` (never `25 cm`) and `,` →
//!   delete keeps `1,200`. This is a clinical-safety rule and can't be
//!   turned off.
//! - Punctuation a rule writes attaches to the word before it
//!   (`findings {comma} liver` → `findings, liver`). A new line takes the
//!   spaces around it. Runs of spaces collapse and the ends are trimmed.
//! - Optionally, the first letter after a `.`, `?`, `!` or new line that a
//!   rule wrote is capitalised.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct TextRule {
    /// Stable id for the settings list.
    pub id: String,
    /// What the speech model writes, such as `{comma}`.
    pub find: String,
    /// What to write instead. Empty deletes the match; `"\n"` is a new line.
    pub replace: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// The rules a fresh install starts with: the model's own periods go, and
/// spoken punctuation tokens become punctuation.
pub fn default_rules() -> Vec<TextRule> {
    [
        ("default-strip-period", ".", ""),
        ("default-period", "{period}", "."),
        ("default-comma", "{comma}", ","),
        ("default-newline", "{newline}", "\n"),
    ]
    .into_iter()
    .map(|(id, find, replace)| TextRule {
        id: id.into(),
        find: find.into(),
        replace: replace.into(),
        enabled: true,
    })
    .collect()
}

/// Builds the regex for one rule's find text. `None` for an empty find.
fn pattern_for(find: &str) -> Option<String> {
    let find = find.trim();
    if find.is_empty() {
        return None;
    }
    // Words match whole words only: a `period` rule leaves "periodic" alone.
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut pattern = String::new();
    if word(find.chars().next()) {
        pattern.push_str(r"\b");
    }
    let mut chars = find.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            while chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
            pattern.push_str(r"\s+");
        } else if c == '{' {
            pattern.push_str(r"\{\s*");
            while chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
        } else if c == '}' {
            // Spaces before `}` were already turned into `\s+`; make them optional.
            if pattern.ends_with(r"\s+") {
                pattern.truncate(pattern.len() - 3);
            }
            pattern.push_str(r"\s*\}");
        } else {
            pattern.push_str(&regex::escape(&c.to_string()));
        }
    }
    if word(find.chars().next_back()) {
        pattern.push_str(r"\b");
    }
    Some(pattern)
}

struct Compiled {
    regex: Regex,
    /// Replacement text for each capture group, in group order.
    replacements: Vec<String>,
}

fn compile(rules: &[TextRule]) -> Option<Compiled> {
    let mut active: Vec<(String, &str)> = rules
        .iter()
        .filter(|rule| rule.enabled)
        .filter_map(|rule| pattern_for(&rule.find).map(|p| (p, rule.replace.as_str())))
        .collect();
    if active.is_empty() {
        return None;
    }
    // The regex takes the first alternative that matches at a position, so
    // longer find text goes first: `{newline}` beats `{new`.
    active.sort_by_key(|(pattern, _)| std::cmp::Reverse(pattern.len()));
    let alternation = active
        .iter()
        .map(|(pattern, _)| format!("({pattern})"))
        .collect::<Vec<_>>()
        .join("|");
    let regex = RegexBuilder::new(&alternation)
        .case_insensitive(true)
        .build()
        .ok()?;
    Some(Compiled {
        regex,
        replacements: active.into_iter().map(|(_, r)| r.to_string()).collect(),
    })
}

fn is_punctuation(c: char) -> bool {
    !c.is_alphanumeric() && !c.is_whitespace()
}

/// Whether a match is only punctuation with a digit directly on both sides,
/// like the `.` in `2.5` or the `,` in `1,200`.
fn protected_number_mark(text: &str, start: usize, end: usize) -> bool {
    let matched = &text[start..end];
    !matched.is_empty()
        && matched.chars().all(is_punctuation)
        && text[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_digit())
        && text[end..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
}

/// Removes spaces and tabs at the end of `out`.
fn trim_trailing_blanks(out: &mut String) {
    let kept = out.trim_end_matches([' ', '\t']).len();
    out.truncate(kept);
}

/// Applies `rules` to `text`. Returns `text` unchanged when no rule is enabled.
pub fn apply(text: &str, rules: &[TextRule], capitalize: bool) -> String {
    let Some(compiled) = compile(rules) else {
        return text.to_string();
    };

    let mut out = String::with_capacity(text.len());
    // Capitalise the next letter (set after a rule writes a sentence end).
    let mut capitalize_next = false;
    // Skip spaces at the start of the next copied text (after a new line).
    let mut skip_leading_blanks = false;
    let mut last = 0;

    // Copies original text between matches, applying pending fix-ups.
    fn copy(
        out: &mut String,
        segment: &str,
        capitalize_next: &mut bool,
        skip_leading_blanks: &mut bool,
    ) {
        let segment = if *skip_leading_blanks {
            segment.trim_start_matches([' ', '\t'])
        } else {
            segment
        };
        if !segment.is_empty() {
            *skip_leading_blanks = false;
        }
        for c in segment.chars() {
            if *capitalize_next && !c.is_whitespace() {
                *capitalize_next = false;
                if c.is_lowercase() {
                    out.extend(c.to_uppercase());
                    continue;
                }
            }
            out.push(c);
        }
    }

    for captures in compiled.regex.captures_iter(text) {
        let whole = captures.get(0).expect("group 0 always matches");
        if protected_number_mark(text, whole.start(), whole.end()) {
            continue;
        }
        let rule = (1..captures.len())
            .find(|&i| captures.get(i).is_some())
            .expect("one alternative matched")
            - 1;
        let replacement = compiled.replacements[rule].as_str();

        copy(
            &mut out,
            &text[last..whole.start()],
            &mut capitalize_next,
            &mut skip_leading_blanks,
        );
        last = whole.end();

        if replacement.is_empty() {
            continue;
        }
        if replacement.starts_with('\n') {
            trim_trailing_blanks(&mut out);
            skip_leading_blanks = true;
        } else if replacement.starts_with(is_punctuation) {
            trim_trailing_blanks(&mut out);
        }
        out.push_str(replacement);
        if replacement.ends_with('\n') {
            skip_leading_blanks = true;
        }
        if capitalize
            && replacement
                .trim_end_matches([' ', '\t'])
                .ends_with(['.', '?', '!', '\n'])
        {
            capitalize_next = true;
        }
    }
    copy(
        &mut out,
        &text[last..],
        &mut capitalize_next,
        &mut skip_leading_blanks,
    );

    tidy(&out)
}

/// Collapses runs of spaces, drops spaces around new lines, trims the ends.
fn tidy(text: &str) -> String {
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let mut collapsed = String::with_capacity(line.len());
            let mut previous_blank = false;
            for c in line.chars() {
                let blank = c == ' ' || c == '\t';
                if !(blank && previous_blank) {
                    collapsed.push(if blank { ' ' } else { c });
                }
                previous_blank = blank;
            }
            collapsed.trim().to_string()
        })
        .collect();
    lines.join("\n").trim().to_string()
}

/// Applies the rules from settings, if they're turned on.
pub fn apply_from_settings(settings: &crate::settings::AppSettings, text: String) -> String {
    if !settings.text_rules_enabled || text.is_empty() {
        return text;
    }
    apply(&text, &settings.text_rules, settings.text_rules_capitalize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(find: &str, replace: &str) -> TextRule {
        TextRule {
            id: find.into(),
            find: find.into(),
            replace: replace.into(),
            enabled: true,
        }
    }

    fn run(text: &str) -> String {
        apply(text, &default_rules(), false)
    }

    #[test]
    fn keeps_decimals_when_deleting_periods() {
        assert_eq!(
            run("the lesion measures 2.5 cm."),
            "the lesion measures 2.5 cm"
        );
        assert_eq!(run("value 0.75 and 10.25."), "value 0.75 and 10.25");
    }

    #[test]
    fn keeps_thousands_separators_when_deleting_commas() {
        let rules = [rule(",", "")];
        assert_eq!(apply("1,200 mL, stable", &rules, false), "1,200 mL stable");
    }

    #[test]
    fn spoken_tokens_become_punctuation() {
        assert_eq!(
            run("no acute findings {period} liver is normal"),
            "no acute findings. liver is normal"
        );
        assert_eq!(
            run("one {period} two {period} three {period}"),
            "one. two. three."
        );
        assert_eq!(run("{period} starts here"), ". starts here");
        assert_eq!(run("liver {comma} spleen"), "liver, spleen");
    }

    #[test]
    fn model_periods_go_and_spoken_periods_stay() {
        assert_eq!(
            run("No acute findings {period} Liver is normal."),
            "No acute findings. Liver is normal"
        );
        assert_eq!(run("size 3.2 cm {period} stable."), "size 3.2 cm. stable");
    }

    #[test]
    fn tokens_ignore_case_and_inner_spaces() {
        assert_eq!(run("mixed {Period} case {PERIOD}"), "mixed. case.");
        assert_eq!(run("spaced { period } token"), "spaced. token");
        assert_eq!(run("attached{period}next"), "attached.next");
    }

    #[test]
    fn rules_dont_act_on_each_others_output() {
        // Either order: the comma {comma} writes is never deleted.
        let a = [rule(",", ""), rule("{comma}", ",")];
        let b = [rule("{comma}", ","), rule(",", "")];
        let text = "liver, spleen {comma} kidneys";
        assert_eq!(apply(text, &a, false), "liver spleen, kidneys");
        assert_eq!(apply(text, &b, false), "liver spleen, kidneys");
    }

    #[test]
    fn longer_find_wins() {
        let rules = [rule("{new", "X"), rule("{newline}", "\n")];
        assert_eq!(apply("a {newline} b", &rules, false), "a\nb");
    }

    #[test]
    fn new_line_takes_the_spaces_around_it() {
        assert_eq!(
            run("impression {newline} no change"),
            "impression\nno change"
        );
        assert_eq!(
            run("findings {period} {newline} impression"),
            "findings.\nimpression"
        );
    }

    #[test]
    fn capitalises_after_sentence_ends_and_new_lines() {
        let rules = default_rules();
        assert_eq!(
            apply("first {period} second {period} 3 lesions", &rules, true),
            "first. Second. 3 lesions"
        );
        assert_eq!(apply("a {newline} b", &rules, true), "a\nB");
        assert_eq!(
            apply("caf\u{e9} {period} \u{e9}lan", &rules, true),
            "caf\u{e9}. \u{c9}lan"
        );
        // Not after a comma.
        assert_eq!(apply("a {comma} b", &rules, true), "a, b");
    }

    #[test]
    fn plain_word_rules_match_whole_text_case_insensitively() {
        let rules = [rule("full stop", ".")];
        assert_eq!(
            apply("normal Full  Stop next", &rules, false),
            "normal. next"
        );
    }

    #[test]
    fn word_rules_match_whole_words_only() {
        let rules = [rule("period", ".")];
        assert_eq!(
            apply("periodic review period done", &rules, false),
            "periodic review. done"
        );
    }

    #[test]
    fn collapses_spaces_and_trims() {
        assert_eq!(run("  extra   spaces  here  "), "extra spaces here");
        assert_eq!(run(""), "");
        assert_eq!(run("no periods at all"), "no periods at all");
    }

    #[test]
    fn disabled_and_empty_rules_change_nothing() {
        let mut disabled = rule(".", "");
        disabled.enabled = false;
        assert_eq!(apply("keep. this  ", &[disabled], false), "keep. this  ");
        assert_eq!(apply("keep. this", &[rule("  ", "x")], false), "keep. this");
        assert_eq!(apply("keep. this", &[], false), "keep. this");
    }

    #[test]
    fn find_text_is_literal_not_regex() {
        let rules = [rule("a.b", "X")];
        assert_eq!(apply("a.b axb", &rules, false), "X axb");
    }
}

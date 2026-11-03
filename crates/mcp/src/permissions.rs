//! What Claude may do in the open project. The user sets it in the History tab
//! ("Allowed to", "Ask before export"); the engine saves it in the project as
//! `project.mcp = { allowed: "all" | "edit" | "look", askBeforeExport }`.

use serde_json::Value;

/// What a tool does, for the permission check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Reads only: summaries, frames, lists, status.
    Look,
    /// Changes the project in an undoable way.
    Edit,
    /// Brings files into the library.
    Import,
    /// Takes files out of the library (risky: always asks).
    Remove,
    /// Writes video files (asks when "Ask before export" is on).
    Export,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Allowed {
    Look,
    Edit,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub allowed: Allowed,
    pub ask_before_export: bool,
}

impl Default for Settings {
    /// The contract's default: `{ allowed: "all", askBeforeExport: true }`.
    fn default() -> Self {
        Settings { allowed: Allowed::All, ask_before_export: true }
    }
}

impl Settings {
    /// Reads the settings from a `project.current` snapshot. No project, or a project saved
    /// before the setting existed, gets the defaults. An unknown `allowed` value is read as
    /// the strictest one, so a typo never widens what Claude may do.
    pub fn from_snapshot(snapshot: &Value) -> Settings {
        let mcp = snapshot.get("project").and_then(|p| p.get("mcp")).or_else(|| snapshot.get("mcp"));
        let Some(mcp) = mcp.filter(|m| m.is_object()) else { return Settings::default() };
        let allowed = match mcp.get("allowed").and_then(Value::as_str) {
            None => Allowed::All,
            Some("all") => Allowed::All,
            Some("edit") => Allowed::Edit,
            Some(_) => Allowed::Look,
        };
        let ask_before_export = mcp.get("askBeforeExport").and_then(Value::as_bool).unwrap_or(true);
        Settings { allowed, ask_before_export }
    }

    pub fn allowed_name(&self) -> &'static str {
        match self.allowed {
            Allowed::Look => "look",
            Allowed::Edit => "edit",
            Allowed::All => "all",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Allowed, but only after the user says yes in Studio (`approval.request`).
    Ask,
    Refuse(String),
}

const WHERE: &str = "The user can change this in Studio's History tab (\"Allowed to\").";

pub fn decide(class: Class, s: &Settings) -> Decision {
    match (class, s.allowed) {
        (Class::Look, _) => Decision::Allow,
        (_, Allowed::Look) => Decision::Refuse(format!("This project only lets Claude look, not edit. {WHERE}")),
        (Class::Edit, _) => Decision::Allow,
        (Class::Import, Allowed::Edit) => Decision::Refuse(format!("This project lets Claude edit, but not import files. {WHERE}")),
        (Class::Remove, Allowed::Edit) => Decision::Refuse(format!("This project lets Claude edit, but not remove files from the library. {WHERE}")),
        (Class::Export, Allowed::Edit) => Decision::Refuse(format!("This project lets Claude edit, but not export. {WHERE}")),
        (Class::Import, Allowed::All) => Decision::Allow,
        (Class::Remove, Allowed::All) => Decision::Ask,
        (Class::Export, Allowed::All) => {
            if s.ask_before_export {
                Decision::Ask
            } else {
                Decision::Allow
            }
        }
    }
}

/// The text for a refused approval, from `approval.request`'s answer.
pub fn refusal_from_answer(what: &str, answer: &Value) -> Option<String> {
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    Some(match answer.get("reason").and_then(Value::as_str) {
        Some("no window open") => {
            let hint = if what.starts_with("Export") { ", or the user can turn off \"Ask before export\" in the History tab" } else { "" };
            format!("{what} needs the user's OK in Studio, and no Studio window is open to ask. Open Studio and try again{hint}.")
        }
        Some(reason) => format!("{what} wasn't approved: {reason}."),
        None => format!("The user said no to {}.", what.to_lowercase()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(allowed: Allowed, ask: bool) -> Settings {
        Settings { allowed, ask_before_export: ask }
    }

    #[test]
    fn look_refuses_every_change() {
        let look = s(Allowed::Look, false);
        assert_eq!(decide(Class::Look, &look), Decision::Allow);
        for class in [Class::Edit, Class::Import, Class::Remove, Class::Export] {
            assert!(matches!(decide(class, &look), Decision::Refuse(_)), "{class:?}");
        }
    }

    #[test]
    fn edit_refuses_imports_removals_and_export() {
        let edit = s(Allowed::Edit, false);
        assert_eq!(decide(Class::Look, &edit), Decision::Allow);
        assert_eq!(decide(Class::Edit, &edit), Decision::Allow);
        for class in [Class::Import, Class::Remove, Class::Export] {
            assert!(matches!(decide(class, &edit), Decision::Refuse(_)), "{class:?}");
        }
    }

    #[test]
    fn all_allows_everything_but_asks_for_risky_things() {
        let all = s(Allowed::All, true);
        assert_eq!(decide(Class::Edit, &all), Decision::Allow);
        assert_eq!(decide(Class::Import, &all), Decision::Allow);
        assert_eq!(decide(Class::Remove, &all), Decision::Ask);
        assert_eq!(decide(Class::Export, &all), Decision::Ask);
        let no_ask = s(Allowed::All, false);
        assert_eq!(decide(Class::Export, &no_ask), Decision::Allow);
        // Removing media always asks, whatever "Ask before export" says.
        assert_eq!(decide(Class::Remove, &no_ask), Decision::Ask);
    }

    #[test]
    fn settings_default_when_missing() {
        assert_eq!(Settings::from_snapshot(&Value::Null), Settings::default());
        assert_eq!(Settings::from_snapshot(&json!({ "project": { "name": "x" } })), Settings::default());
        assert!(Settings::default().ask_before_export);
        assert_eq!(Settings::default().allowed, Allowed::All);
    }

    #[test]
    fn settings_read_from_project() {
        let snap = json!({ "project": { "mcp": { "allowed": "edit", "askBeforeExport": false } } });
        assert_eq!(Settings::from_snapshot(&snap), s(Allowed::Edit, false));
        let snap = json!({ "project": { "mcp": { "allowed": "look" } } });
        assert_eq!(Settings::from_snapshot(&snap), s(Allowed::Look, true));
    }

    #[test]
    fn unknown_level_is_strictest() {
        let snap = json!({ "project": { "mcp": { "allowed": "everything!" } } });
        assert_eq!(Settings::from_snapshot(&snap).allowed, Allowed::Look);
    }

    #[test]
    fn approval_answers() {
        assert_eq!(refusal_from_answer("Export", &json!({ "ok": true })), None);
        assert!(refusal_from_answer("Export", &json!({ "ok": false, "reason": "no window open" })).unwrap().contains("no Studio window is open"));
        assert!(refusal_from_answer("Export", &json!({ "ok": false })).unwrap().contains("said no"));
        // Anything that isn't a clear yes is a no.
        assert!(refusal_from_answer("Export", &json!({})).is_some());
        assert!(refusal_from_answer("Export", &Value::Null).is_some());
    }
}

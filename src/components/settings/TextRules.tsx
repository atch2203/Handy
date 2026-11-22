import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type TextRule } from "@/bindings";
import { useSettings } from "../../hooks/useSettings";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { SettingContainer } from "../ui/SettingContainer";
import { Dropdown } from "../ui/Dropdown";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Textarea";

const NEW_LINE = "\n";

type ReplaceMode = "text" | "newline" | "delete";

const modeOf = (replace: string): ReplaceMode =>
  replace === "" ? "delete" : replace === NEW_LINE ? "newline" : "text";

const newRuleId = () =>
  `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Find → replace rules applied to dictation before it's pasted, for speech
// models that write spoken punctuation as tokens such as {comma}.
export const TextRules: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const enabled = getSetting("text_rules_enabled") ?? false;
  const capitalize = getSetting("text_rules_capitalize") ?? true;
  const savedRules = getSetting("text_rules");

  // Edited locally and saved when a field loses focus, not on every key.
  const [rules, setRules] = useState<TextRule[]>(savedRules ?? []);
  useEffect(() => setRules(savedRules ?? []), [savedRules]);

  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState("");

  const save = (next: TextRule[]) => {
    setRules(next);
    updateSetting("text_rules", next);
  };
  const edit = (id: string, change: Partial<TextRule>) =>
    setRules((current) =>
      current.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)),
    );
  const saveEdits = () => {
    if (JSON.stringify(rules) !== JSON.stringify(savedRules)) {
      updateSetting("text_rules", rules);
    }
  };

  // Re-run the sample through the saved rules whenever either changes.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await commands.previewTextRules(sample);
        if (!cancelled) setPreview(result);
      } catch (error) {
        console.error("Failed to preview text rules:", error);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sample, savedRules, capitalize]);

  const modeOptions = [
    { value: "text", label: t("settings.textRules.replaceWith.text") },
    { value: "newline", label: t("settings.textRules.replaceWith.newline") },
    { value: "delete", label: t("settings.textRules.replaceWith.delete") },
  ];

  const setMode = (rule: TextRule, mode: string) => {
    const replace =
      mode === "delete"
        ? ""
        : mode === "newline"
          ? NEW_LINE
          : modeOf(rule.replace) === "text"
            ? rule.replace
            : ".";
    save(rules.map((r) => (r.id === rule.id ? { ...r, replace } : r)));
  };

  const updating = isUpdating("text_rules");

  return (
    <>
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => updateSetting("text_rules_enabled", value)}
        isUpdating={isUpdating("text_rules_enabled")}
        label={t("settings.textRules.enabled.label")}
        description={t("settings.textRules.enabled.description")}
        descriptionMode="tooltip"
        grouped
      />
      <ToggleSwitch
        checked={capitalize}
        onChange={(value) => updateSetting("text_rules_capitalize", value)}
        isUpdating={isUpdating("text_rules_capitalize")}
        label={t("settings.textRules.capitalize.label")}
        description={t("settings.textRules.capitalize.description")}
        descriptionMode="tooltip"
        grouped
      />
      <SettingContainer
        title={t("settings.textRules.rules.title")}
        description={t("settings.textRules.rules.description")}
        descriptionMode="inline"
        layout="stacked"
        grouped
      >
        <div className="flex flex-col gap-2">
          {rules.length === 0 && (
            <p className="text-sm text-ink-3">
              {t("settings.textRules.rules.empty")}
            </p>
          )}
          {rules.map((rule) => {
            const mode = modeOf(rule.replace);
            return (
              <div key={rule.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) =>
                    save(
                      rules.map((r) =>
                        r.id === rule.id
                          ? { ...r, enabled: e.target.checked }
                          : r,
                      ),
                    )
                  }
                  aria-label={t("settings.textRules.rules.ruleOn")}
                  title={t("settings.textRules.rules.ruleOn")}
                  disabled={updating}
                />
                <Input
                  type="text"
                  variant="compact"
                  className="w-32 min-w-0 font-mono"
                  value={rule.find}
                  placeholder={t("settings.textRules.rules.findPlaceholder")}
                  aria-label={t("settings.textRules.rules.find")}
                  onChange={(e) => edit(rule.id, { find: e.target.value })}
                  onBlur={saveEdits}
                />
                <span className="text-ink-3" aria-hidden>
                  →
                </span>
                <Dropdown
                  className="w-32"
                  options={modeOptions}
                  selectedValue={mode}
                  onSelect={(value) => setMode(rule, value)}
                  disabled={updating}
                />
                {mode === "text" && (
                  <Input
                    type="text"
                    variant="compact"
                    className="w-24 min-w-0 font-mono"
                    value={rule.replace}
                    aria-label={t("settings.textRules.rules.replace")}
                    onChange={(e) => edit(rule.id, { replace: e.target.value })}
                    onBlur={saveEdits}
                  />
                )}
                <Button
                  variant="danger-ghost"
                  size="sm"
                  className="ms-auto"
                  onClick={() => save(rules.filter((r) => r.id !== rule.id))}
                  disabled={updating}
                >
                  {t("settings.textRules.rules.remove")}
                </Button>
              </div>
            );
          })}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                save([
                  ...rules,
                  { id: newRuleId(), find: "", replace: "", enabled: true },
                ])
              }
              disabled={updating}
            >
              {t("settings.textRules.rules.add")}
            </Button>
          </div>
        </div>
      </SettingContainer>
      <SettingContainer
        title={t("settings.textRules.tryIt.title")}
        description={t("settings.textRules.tryIt.description")}
        descriptionMode="inline"
        layout="stacked"
        grouped
      >
        <div className="flex flex-col gap-2">
          <Textarea
            rows={2}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder={t("settings.textRules.tryIt.placeholder")}
          />
          {sample && (
            <p className="whitespace-pre-wrap rounded-md border border-line bg-wash px-3 py-2 text-sm">
              {preview}
            </p>
          )}
        </div>
      </SettingContainer>
    </>
  );
};

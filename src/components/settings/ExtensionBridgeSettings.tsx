import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type ExtensionBridgeStatus } from "@/bindings";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { notify } from "../../stores/noticeStore";
import { copyToClipboard } from "./history/clipboard";

const STATUS_POLL_MS = 2000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// Shown under the paste method while "Send to browser extension" is chosen:
// the port and token the extension needs, and whether it's connected.
export const ExtensionBridgeSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const port = getSetting("extension_bridge_port") ?? 47813;
  const token = getSetting("extension_bridge_token") ?? "";

  const [portDraft, setPortDraft] = useState(String(port));
  const [status, setStatus] = useState<ExtensionBridgeStatus | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => setPortDraft(String(port)), [port]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await commands.getExtensionBridgeStatus();
        if (!cancelled) setStatus(next);
      } catch (error) {
        console.error("Failed to get extension bridge status:", error);
      }
    };
    poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const parsedPort = Number(portDraft);
  const portValid =
    Number.isInteger(parsedPort) &&
    parsedPort >= MIN_PORT &&
    parsedPort <= MAX_PORT;

  const commitPort = () => {
    if (portValid && parsedPort !== port) {
      updateSetting("extension_bridge_port", parsedPort);
    } else if (!portValid) {
      setPortDraft(String(port));
    }
  };

  const copyToken = async () => {
    if (!(await copyToClipboard(token))) {
      notify({ title: t("settings.advanced.extensionBridge.copyFailed") });
    }
  };

  const regenerateToken = async () => {
    setRegenerating(true);
    try {
      const result = await commands.regenerateExtensionBridgeToken();
      if (result.status === "error") throw new Error(result.error);
      await refreshSettings();
    } catch (error) {
      console.error("Failed to regenerate extension token:", error);
      notify({
        title: t("settings.advanced.extensionBridge.regenerateFailed"),
      });
    } finally {
      setRegenerating(false);
    }
  };

  const statusText = !status?.listening
    ? t("settings.advanced.extensionBridge.status.notListening", { port })
    : status.connected
      ? t("settings.advanced.extensionBridge.status.connected")
      : t("settings.advanced.extensionBridge.status.waiting");
  const statusColor = !status?.listening
    ? "bg-error"
    : status.connected
      ? "bg-green-500"
      : "bg-warning";

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2" role="status">
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
        <span>{statusText}</span>
      </div>

      <label className="flex items-center gap-2">
        <span className="w-14 shrink-0">
          {t("settings.advanced.extensionBridge.port")}
        </span>
        <Input
          type="number"
          min={MIN_PORT}
          max={MAX_PORT}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPort();
          }}
          disabled={isUpdating("extension_bridge_port")}
          className="w-28"
        />
      </label>

      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0">
          {t("settings.advanced.extensionBridge.token")}
        </span>
        <Input
          type="text"
          readOnly
          value={token}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button variant="secondary" size="sm" onClick={copyToken}>
          {t("settings.advanced.extensionBridge.copy")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={regenerateToken}
          disabled={regenerating}
          title={t("settings.advanced.extensionBridge.regenerateHint")}
        >
          {t("settings.advanced.extensionBridge.regenerate")}
        </Button>
      </div>
    </div>
  );
};

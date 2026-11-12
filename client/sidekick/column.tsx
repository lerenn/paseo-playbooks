import { Icon, Markdown, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { formatSize } from "../../shared/attachments";
import type { Theme } from "../theme";
import { useAttachments } from "./attach";
import { sidekickUi, useSidekickUi } from "./ui-state";
import { isQueueKey, mergeQueued, queueAction, shouldFlush } from "./queue";
import { describePermission, humanizeTool, toolIcon, toolSummary } from "./describe";
import { pluginMessage } from "./instructions";
import type { Item, PermissionRequest } from "./reduce";
import { useSidekickChat, type PermissionResponse } from "./use-chat";

interface Props {
  theme: Theme;
  agentId: string | null;
  /** Opens the agent as a native tab, where everything the chat lacks (model, mode) lives. */
  onOpenTab?: (() => void) | undefined;
  /** Restarts the Sidekick as a new session (asks first). */
  onRestart?: (() => Promise<void>) | undefined;
  /** The project tab: its unsent message is kept in the UI store. */
  projectId: string;
  /** Set while the Sidekick is being created or its RPC failed. */
  status: { loading: boolean; error: string | null };
}

/** The chat of one project's Sidekick, inside the column's frame (pane.tsx): a plain chat over the agent's timeline. */
export function SidekickChat(props: Props) {
  const { theme, agentId, status } = props;
  const chat = useSidekickChat(agentId);
  const toast = useToast();
  const { state } = chat;
  const ui = useSidekickUi();
  const draft = ui.drafts[props.projectId] ?? "";
  const queued = ui.queued[props.projectId];
  const setDraft = (text: string) => sidekickUi.setDraft(props.projectId, text);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [sending, setSending] = useState(false);
  const composer = useRef<unknown>(null);
  const attachments = useAttachments(composer, (message) => toast.error(message));
  const scroller = useRef<{ scrollToEnd?: (options?: { animated?: boolean }) => void } | null>(null);
  useEffect(() => scroller.current?.scrollToEnd?.({ animated: false }), [state.items, state.permissions.length]);

  const submit = (queue = false) => {
    const text = draft.trim();
    if ((!text && attachments.items.length === 0) || sending) return;
    if (queue && queueAction(state.running) === "queue") {
      sidekickUi.setQueued(props.projectId, mergeQueued(queued, { text, attachments: attachments.items }));
      setDraft("");
      attachments.clear();
      return;
    }
    setSending(true);
    chat
      .send(text, attachments.items)
      .then(() => {
        setDraft("");
        attachments.clear();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not send"))
      .finally(() => setSending(false));
  };
  // The queued message goes out as soon as the turn has ended.
  const live = state.connection === "live";
  useEffect(() => {
    if (!queued || !shouldFlush(queued, { live, running: state.running, sending })) return;
    sidekickUi.setQueued(props.projectId, null);
    setSending(true);
    chat
      .send(queued.text, queued.attachments)
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Could not send the queued message");
        if (!sidekickUi.get().drafts[props.projectId]) sidekickUi.setDraft(props.projectId, queued.text);
      })
      .finally(() => setSending(false));
  }, [queued, live, state.running, sending]); // eslint-disable-line react-hooks/exhaustive-deps
  const stop = () => chat.stop().catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not stop"));
  const respond = (id: string, response: PermissionResponse) =>
    chat.respond(id, response).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not answer"));

  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ flex: 1 }}>
      {chat.info.model || props.onOpenTab || props.onRestart ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.border }}>
          <Text style={{ color: muted, fontSize: 11, flex: 1 }} numberOfLines={1}>
            {chat.info.model ? `${chat.info.model}${chat.info.mode ? ` · ${chat.info.mode}` : ""}` : ""}
          </Text>
          {props.onRestart && agentId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirmRestart ? "Confirm: restart the Sidekick as a new session" : "Start a new Sidekick session"}
              {...({ title: confirmRestart ? "Press again to restart" : "New session (continues from the last hand-off)" } as object)}
              hitSlop={8}
              onPress={() => {
                if (!confirmRestart) return setConfirmRestart(true);
                setConfirmRestart(false);
                void props.onRestart!();
              }}
              onBlur={() => setConfirmRestart(false)}
            >
              {confirmRestart ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>Restart?</Text> : <Icon name="RotateCcw" size={15} color={muted} />}
            </Pressable>
          ) : null}
          {props.onOpenTab ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Open the Sidekick as an agent tab" hitSlop={8} onPress={props.onOpenTab}>
              <Icon name="ExternalLink" size={15} color={muted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <ScrollView ref={scroller as never} style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 18 }}>
        {status.loading ? <Text style={{ color: muted }}>Starting the Sidekick…</Text> : null}
        {status.error ? <Text style={{ color: theme.colors.statusDanger }}>{status.error}</Text> : null}
        {state.connection === "error" && state.error ? <Text style={{ color: theme.colors.statusWarning }}>Reconnecting… {state.error}</Text> : null}
        {state.items.map((item) => (
          <ItemView key={item.key} theme={theme} item={item} />
        ))}
        {state.running ? <Text style={{ color: muted, fontSize: 12 }}>Working…</Text> : null}
        {state.permissions.map((request) => (
          <PermissionView key={request.id} theme={theme} request={request} onRespond={(response) => respond(request.id, response)} />
        ))}
      </ScrollView>

      <View ref={composer as never} style={{ padding: 10, gap: 8, borderTopWidth: 1, borderColor: attachments.dragging ? theme.colors.accent : theme.colors.border, backgroundColor: attachments.dragging ? theme.colors.surface1 : undefined }}>
        {attachments.items.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
            {attachments.items.map((item) => (
              <View key={item.id} style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 4, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 200 }}>
                {item.previewUri ? <Image source={{ uri: item.previewUri }} accessibilityLabel={`Preview of ${item.name}`} style={{ width: 36, height: 36, borderRadius: 4 }} /> : <Icon name="File" size={20} color={muted} />}
                <View style={{ flexShrink: 1 }}>
                  <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11 }}>{item.name}</Text>
                  <Text style={{ color: muted, fontSize: 10 }}>{formatSize(item.size)}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.name}`} hitSlop={8} onPress={() => attachments.remove(item.id)}>
                  <Icon name="X" size={14} color={muted} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {queued ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 8, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border, paddingHorizontal: 8, paddingVertical: 6 }}>
            <Icon name="Clock" size={13} color={muted} />
            <Text style={{ color: muted, fontSize: 12, flex: 1 }} numberOfLines={2}>
              Queued: {queued.text || `${queued.attachments.length} attachment(s)`}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel the queued message" hitSlop={8} onPress={() => sidekickUi.setQueued(props.projectId, null)}>
              <Icon name="X" size={14} color={muted} />
            </Pressable>
          </View>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={agentId ? (state.running ? "Enter sends into the running turn, ⌘/Ctrl+Enter queues" : "Message the Sidekick (paste or drop files)") : "Starting…"}
          placeholderTextColor={muted}
          editable={agentId !== null}
          multiline
          onKeyPress={(event) => {
            const key = event.nativeEvent as unknown as { key?: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };
            if (key.key === "Enter" && !key.shiftKey) {
              (event as unknown as { preventDefault?: () => void }).preventDefault?.();
              submit(isQueueKey(key));
            }
          }}
          style={{ minHeight: 40, maxHeight: 140, color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 }}
        />
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          {state.running ? <ColumnButton theme={theme} label="Stop" onPress={stop} tone="danger" /> : null}
          {state.running ? <ColumnButton theme={theme} label="Queue" onPress={() => submit(true)} disabled={(!draft.trim() && attachments.items.length === 0) || sending || agentId === null} tone="plain" /> : null}
          <ColumnButton theme={theme} label="Send" onPress={() => submit()} disabled={(!draft.trim() && attachments.items.length === 0) || sending || agentId === null} tone="primary" />
        </View>
      </View>
    </View>
  );
}

function ColumnButton(props: { theme: Theme; label: string; onPress: () => void; disabled?: boolean; tone: "primary" | "danger" | "plain" }) {
  const { theme } = props;
  const color = props.tone === "danger" ? theme.colors.statusDanger : theme.colors.accent;
  const filled = props.tone === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ borderRadius: 7, borderWidth: 1, borderColor: props.tone === "plain" ? theme.colors.border : color, backgroundColor: filled ? color : "transparent", paddingHorizontal: 12, paddingVertical: 6, opacity: props.disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: filled ? theme.colors.accentForeground : props.tone === "plain" ? theme.colors.foreground : color, fontWeight: "600", fontSize: 12 }}>{props.label}</Text>
    </Pressable>
  );
}

function ItemView({ theme, item }: { theme: Theme; item: Item }) {
  const muted = theme.colors.foregroundMuted;
  switch (item.kind) {
    case "user":
      if (item.instructions) return <InstructionsLine theme={theme} text={item.text} />;
      if (pluginMessage(item.text)) return <PluginMessageLine theme={theme} message={pluginMessage(item.text)!} />;
      return (
        <View style={{ alignSelf: "flex-end", maxWidth: "90%", borderRadius: 10, backgroundColor: theme.colors.surface1, padding: 12, marginTop: 8 }}>
          <Text selectable style={{ color: theme.colors.foreground }}>{item.text}</Text>
        </View>
      );
    case "assistant":
      return <Markdown>{item.text}</Markdown>;
    case "reasoning":
      return <ReasoningLine theme={theme} text={item.text} streaming={item.streaming} />;
    case "notice":
      return <Row theme={theme} icon={item.level === "info" ? "Info" : "TriangleAlert"} label={item.text} color={item.level === "error" ? theme.colors.statusDanger : item.level === "warning" ? theme.colors.statusWarning : muted} />;
    case "tool":
      return <ToolCard theme={theme} item={item} />;
  }
}

/** The agent's reasoning: one closed line that opens on click, so thoughts do not crowd out the answers. */
function ReasoningLine({ theme, text, streaming }: { theme: Theme; text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Row theme={theme} icon="Brain" label={streaming ? "Thinking…" : "Thinking"} onPress={() => setOpen(!open)} open={open} />
      {open ? <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic", borderLeftWidth: 2, borderColor: theme.colors.border, paddingLeft: 8 }}>{text}</Text> : null}
    </View>
  );
}

/** One flat row, like the official conversation: a small leading icon and one muted line, cut with an ellipsis. */
function Row({ theme, icon, label, summary, color, onPress, open }: { theme: Theme; icon: string; label: string; summary?: string | null; color?: string; onPress?: () => void; open?: boolean }) {
  const muted = color ?? theme.colors.foregroundMuted;
  const content = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={icon as never} size={13} color={muted} />
      <Text style={{ color: muted, fontSize: 12, flex: 1 }} numberOfLines={1}>
        {label}
        {summary ? <Text style={{ opacity: 0.7 }}>{`  ${summary}`}</Text> : null}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={summary ? `${label} ${summary}` : label} accessibilityState={{ expanded: open ?? false }} onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

/** A message the plugin sent (events, notices): a closed line with a badge, so it is not mistaken for something the human wrote; opens on click. */
function PluginMessageLine({ theme, message }: { theme: Theme; message: { summary: string; body: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, borderStyle: "dashed", padding: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Message from the plugin: ${message.summary}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="Workflow" size={13} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }} numberOfLines={open ? undefined : 1}>
          {message.summary}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{open ? "hide" : "show"}</Text>
      </Pressable>
      {open ? <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11, borderLeftWidth: 2, borderColor: theme.colors.border, paddingLeft: 8 }}>{message.body}</Text> : null}
    </View>
  );
}

/** The plugin's first message to the Sidekick: one closed line that opens on click, so it is not mistaken for something the human wrote. */
function InstructionsLine({ theme, text }: { theme: Theme; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Instructions sent to the Sidekick ({open ? "hide" : "show"})
        </Text>
      </Pressable>
      {open ? <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11, borderLeftWidth: 2, borderColor: theme.colors.border, paddingLeft: 8 }}>{text}</Text> : null}
    </View>
  );
}

/** A tool call: one flat row (icon, humanized name, short summary); its input and error when opened. */
function ToolCard({ theme, item }: { theme: Theme; item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Row
        theme={theme}
        icon={item.status === "failed" ? "TriangleAlert" : toolIcon(item.name)}
        label={humanizeTool(item.name)}
        summary={toolSummary(item.detail)}
        {...(item.status === "failed" ? { color: theme.colors.statusDanger } : {})}
        onPress={() => setOpen(!open)}
        open={open}
      />
      {open ? (
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace", paddingLeft: 21 }}>
          {item.error ? `${item.error}\n\n` : ""}
          {item.detail ? JSON.stringify(item.detail, null, 2).slice(0, 4000) : "no detail"}
        </Text>
      ) : null}
    </View>
  );
}

interface Question {
  question: string;
  header: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

function questionsOf(input: unknown): Question[] {
  const list = (input as { questions?: unknown } | null)?.questions;
  return Array.isArray(list) ? list.filter((entry): entry is Question => !!entry && typeof (entry as Question).question === "string" && typeof (entry as Question).header === "string") : [];
}

/** A permission request: allow or deny, or a question (AskUserQuestion) answered by picking options. */
function PermissionView({ theme, request, onRespond }: { theme: Theme; request: PermissionRequest; onRespond: (response: PermissionResponse) => void }) {
  const questions = questionsOf(request.input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const border = { borderRadius: 10, borderWidth: 1, borderColor: theme.colors.statusWarning, padding: 10, gap: 8 } as const;
  if (questions.length > 0) {
    const answers = () =>
      Object.fromEntries(questions.map((q) => [q.header, [...(picked[q.header] ?? []), ...((other[q.header] ?? "").trim() ? [other[q.header]!.trim()] : [])].join(",")]));
    const ready = questions.every((q) => (picked[q.header]?.length ?? 0) > 0 || (other[q.header] ?? "").trim() !== "");
    return (
      <View style={border}>
        {questions.map((q) => (
          <View key={q.header} style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{q.question}</Text>
            {(q.options ?? []).map((option) => {
              const on = picked[q.header]?.includes(option.label) ?? false;
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() =>
                    setPicked((current) => {
                      const now = current[q.header] ?? [];
                      return { ...current, [q.header]: q.multiSelect ? (on ? now.filter((label) => label !== option.label) : [...now, option.label]) : [option.label] };
                    })
                  }
                  style={{ borderRadius: 7, borderWidth: 1, borderColor: on ? theme.colors.accent : theme.colors.border, padding: 8 }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{option.label}</Text>
                  {option.description ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{option.description}</Text> : null}
                </Pressable>
              );
            })}
            <TextInput
              value={other[q.header] ?? ""}
              onChangeText={(text) => setOther((current) => ({ ...current, [q.header]: text }))}
              placeholder="Other…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{ color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 6 }}
            />
          </View>
        ))}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <ColumnButton theme={theme} label="Skip" tone="plain" onPress={() => onRespond({ behavior: "deny", message: "The user skipped the question" })} />
          <ColumnButton theme={theme} label="Answer" tone="primary" disabled={!ready} onPress={() => onRespond({ behavior: "allow", updatedInput: { answers: answers() } })} />
        </View>
      </View>
    );
  }
  const described = describePermission(request.name, request.input);
  const remember = request.suggestions && request.suggestions.length > 0 ? request.suggestions : null;
  return (
    <View style={border}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{described.sentence}</Text>
      {described.summary ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{described.summary}</Text> : null}
      <Text accessibilityLabel={`Tool: ${described.toolId}`} {...({ title: described.toolId } as object)} style={{ color: theme.colors.foregroundMuted, fontSize: 10, opacity: 0.7 }}>{described.toolId}</Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <ColumnButton theme={theme} label="Deny" tone="danger" onPress={() => onRespond({ behavior: "deny" })} />
        {remember ? <ColumnButton theme={theme} label="Allow always" tone="plain" onPress={() => onRespond({ behavior: "allow", updatedPermissions: remember })} /> : null}
        <ColumnButton theme={theme} label="Allow" tone="primary" onPress={() => onRespond({ behavior: "allow" })} />
      </View>
    </View>
  );
}

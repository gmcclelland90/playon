import type { AgentMood, ChatChannelListItem } from "@playon/shared";

type ChannelChip = ChatChannelListItem & {
  mood?: AgentMood;
  nowLine?: string;
};

type Props = {
  channels: ChannelChip[];
  activeKey: string;
  onSelect: (key: string) => void;
};

export function ChatChannelList({ channels, activeKey, onSelect }: Props) {
  return (
    <div className="chat-channels" role="tablist" aria-label="Chat channels">
      {channels.map((channel) => {
        const selected = channel.key === activeKey;
        const mood = channel.mood ?? (channel.pending ? "thinking" : "idle");
        return (
          <button
            key={channel.key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={channel.nowLine ? `${channel.title} · ${channel.nowLine}` : channel.title}
            className={[
              "chat-channel-chip",
              selected ? "selected" : "",
              `mood-${mood}`,
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSelect(channel.key)}
          >
            <span
              className={`chat-channel-pip mood-${mood}`}
              title={channel.nowLine ?? mood}
              aria-hidden
            />
            <span>{channel.title}</span>
          </button>
        );
      })}
    </div>
  );
}

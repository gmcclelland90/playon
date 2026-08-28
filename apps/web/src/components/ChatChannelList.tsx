import type { ChatChannelListItem } from "@playon/shared";

type Props = {
  channels: ChatChannelListItem[];
  activeKey: string;
  onSelect: (key: string) => void;
};

export function ChatChannelList({ channels, activeKey, onSelect }: Props) {
  return (
    <div className="chat-channels" role="tablist" aria-label="Chat channels">
      {channels.map((channel) => {
        const selected = channel.key === activeKey;
        return (
          <button
            key={channel.key}
            type="button"
            role="tab"
            aria-selected={selected}
            className={
              selected
                ? "chat-channel-chip selected"
                : "chat-channel-chip"
            }
            onClick={() => onSelect(channel.key)}
          >
            {channel.pending ? <span className="chat-channel-pip" aria-hidden /> : null}
            <span>{channel.title}</span>
          </button>
        );
      })}
    </div>
  );
}

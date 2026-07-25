import { useState, useRef } from 'react';
import { useNanoclaw } from './useNanoclaw';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Login } from './components/Login';
import { Conversation } from './components/Conversation';
import { PromptInput, type PromptInputHandle } from './components/PromptInput';
import { UpdateBanner } from './components/UpdateBanner';

export default function App() {
  const {
    bootstrapped,
    token,
    showLogin,
    userId,
    status,
    items,
    typing,
    sessions,
    activeSessionId,
    unreadSessionIds,
    newSession,
    switchSession,
    deleteSession,
    authError,
    bundleStale,
    uploadError,
    clearUploadError,
    login,
    sendMessage,
    chooseOption,
  } = useNanoclaw();

  const promptRef = useRef<PromptInputHandle>(null);
  // Mobile drawer only: at `md` and up the sidebar is part of the layout and
  // this flag is ignored (see Sidebar's class switching).
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Avoid a flash of the login screen before the token bootstrap resolves.
  if (!bootstrapped) {
    return <div className="h-full bg-zinc-950" />;
  }

  // Gated on showLogin, NOT on `!token`: a tab with no stored token still
  // tries a bare connect first, because a server behind `tailscale serve`
  // with the identity opt-in on will authenticate it from the injected
  // header (see useNanoclaw.ts). The login screen is what a 4401 close means
  // — same screen, same error copy for a rejected token, as before.
  if (showLogin) {
    return (
      <div className="flex h-full flex-col bg-zinc-950">
        <Login authError={authError} onSubmit={login} />
      </div>
    );
  }

  const connected = status === 'connected';

  return (
    <div
      className="flex h-full bg-zinc-950"
      // Drag-drop onto the whole conversation, not just a small composer
      // target: files-IN's PromptInput owns the actual pending-file state,
      // so this just forwards dropped files to it via the imperative
      // handle (drag-drop doesn't naturally lift to a shared React state
      // owner without either prop-drilling every drag event handler down
      // through Conversation too, or this).
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) promptRef.current?.addFiles(files);
      }}
    >
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        unreadSessionIds={unreadSessionIds}
        userId={userId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={() => {
          newSession();
          setSidebarOpen(false);
        }}
        onSwitch={switchSession}
        onDelete={deleteSession}
      />
      {/* min-w-0: without it the conversation column refuses to shrink below
          its content width next to the fixed-width sidebar, and long code
          blocks push the whole page sideways. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar status={status} userId={userId} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
        {bundleStale && <UpdateBanner onReload={() => window.location.reload()} />}
        <Conversation
          items={items}
          typing={typing}
          connected={connected}
          token={token}
          onChoose={chooseOption}
        />
        <PromptInput
          ref={promptRef}
          disabled={!connected}
          onSend={sendMessage}
          uploadError={uploadError}
          onDismissUploadError={clearUploadError}
        />
      </div>
    </div>
  );
}

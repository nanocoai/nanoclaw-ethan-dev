import { useRef } from 'react';
import { useNanoclaw } from './useNanoclaw';
import { TopBar } from './components/TopBar';
import { Login } from './components/Login';
import { Conversation } from './components/Conversation';
import { PromptInput, type PromptInputHandle } from './components/PromptInput';
import { UpdateBanner } from './components/UpdateBanner';

export default function App() {
  const {
    bootstrapped,
    token,
    status,
    items,
    typing,
    authError,
    bundleStale,
    uploadError,
    clearUploadError,
    login,
    sendMessage,
    chooseOption,
  } = useNanoclaw();

  const promptRef = useRef<PromptInputHandle>(null);

  // Avoid a flash of the login screen before the token bootstrap resolves.
  if (!bootstrapped) {
    return <div className="h-full bg-zinc-950" />;
  }

  if (!token) {
    return (
      <div className="flex h-full flex-col bg-zinc-950">
        <Login authError={authError} onSubmit={login} />
      </div>
    );
  }

  const connected = status === 'connected';

  return (
    <div
      className="flex h-full flex-col bg-zinc-950"
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
      <TopBar status={status} />
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
  );
}

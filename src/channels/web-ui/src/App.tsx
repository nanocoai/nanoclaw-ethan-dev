import { useNanoclaw } from './useNanoclaw';
import { TopBar } from './components/TopBar';
import { Login } from './components/Login';
import { Conversation } from './components/Conversation';
import { PromptInput } from './components/PromptInput';

export default function App() {
  const {
    bootstrapped,
    token,
    status,
    items,
    typing,
    authError,
    login,
    sendMessage,
    chooseOption,
  } = useNanoclaw();

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
    <div className="flex h-full flex-col bg-zinc-950">
      <TopBar status={status} />
      <Conversation
        items={items}
        typing={typing}
        connected={connected}
        onChoose={chooseOption}
      />
      <PromptInput disabled={!connected} onSend={sendMessage} />
    </div>
  );
}

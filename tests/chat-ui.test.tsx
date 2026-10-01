import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeContext } from '../src/app/context';
import { ChatRuntime } from '../src/chat/application/runtime';
import { applyMessage, emptyData } from '../src/chat/domain/model';
import { ChatPane } from '../src/chat/ui/ChatPane';
import { browserDependencies } from '../src/session/browser';

afterEach(cleanup);

function history() {
  let data = emptyData();
  for (let index = 1; index <= 150; index++) {
    data = applyMessage(
      data,
      {
        kind: 'message',
        serverId: String(index),
        chatId: '123',
        name: 'Анна',
        text: `Сообщение ${index}`,
        direction: 'incoming',
        at: index * 1000,
      },
      `local-${index}`,
    );
  }
  return data;
}

describe('conversation history', () => {
  it('renders recent messages first and reveals older messages on demand', () => {
    const data = history();

    const runtime = new ChatRuntime(browserDependencies());
    runtime.store.setState({ data });
    render(
      <RuntimeContext value={runtime}>
        <ChatPane chatId="123" />
      </RuntimeContext>,
    );

    const log = screen.getByRole('log');
    expect(log.querySelectorAll('[data-message-id]')).toHaveLength(100);
    expect(screen.queryByText('Сообщение 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Показать предыдущие сообщения' }));
    expect(log.querySelectorAll('[data-message-id]')).toHaveLength(150);
    expect(screen.getByText('Сообщение 1')).toBeInTheDocument();
  });

  it('opens at the latest page of a long conversation', () => {
    const data = history();
    const runtime = new ChatRuntime(browserDependencies());
    runtime.store.setState({ data });
    render(
      <RuntimeContext value={runtime}>
        <ChatPane chatId="123" />
      </RuntimeContext>,
    );

    expect(screen.getByRole('log').querySelectorAll('[data-message-id]')).toHaveLength(100);
    expect(screen.queryByText('Сообщение 20')).toBeNull();
    expect(screen.getByText('Сообщение 150')).toBeInTheDocument();
  });
});

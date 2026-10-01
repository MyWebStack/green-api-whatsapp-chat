import { useState, type SubmitEvent } from 'react';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { useRuntime } from '../app/context';
import { DEFAULT_API_URL, validateConfig } from '../chat/application/config';
import ui from '../shared/styles/ui.module.scss';
import styles from './ConnectionForm.module.scss';

export function ConnectionForm({ busy, notice }: { busy: boolean; notice: string }) {
  const runtime = useRuntime();
  const [idInstance, setId] = useState('');
  const [apiTokenInstance, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      await runtime.connect(
        validateConfig({ apiUrl: DEFAULT_API_URL, idInstance, apiTokenInstance }),
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Проверьте параметры подключения.');
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={styles.connectForm}
      aria-label="Подключение к GREEN-API"
    >
      <label className={ui.field}>
        ID инстанса
        <input
          name="instance"
          value={idInstance}
          onChange={(event) => setId(event.target.value)}
          placeholder="Например, 1101728000"
          inputMode="numeric"
          autoComplete="off"
          required
          disabled={busy}
        />
      </label>
      <label className={ui.field}>
        Токен API
        <span className={styles.passwordField}>
          <input
            name="token"
            type={tokenVisible ? 'text' : 'password'}
            value={apiTokenInstance}
            onChange={(event) => setToken(event.target.value)}
            placeholder="apiTokenInstance"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
          <button
            type="button"
            className={ui.iconButton}
            aria-label={tokenVisible ? 'Скрыть токен' : 'Показать токен'}
            aria-pressed={tokenVisible}
            onClick={() => setTokenVisible((visible) => !visible)}
          >
            {tokenVisible ? <EyeOff /> : <Eye />}
          </button>
        </span>
      </label>
      {(error || notice) && (
        <p className={ui.formError} role="alert">
          {error || notice}
        </p>
      )}
      <button className={ui.primaryButton} type="submit" disabled={busy}>
        {busy ? (
          <>
            <span className={styles.spinner} />
            Подключаемся…
          </>
        ) : (
          <>
            Подключиться
            <ArrowRight size={18} />
          </>
        )}
      </button>
      {busy && (
        <button type="button" className={ui.textButton} onClick={() => void runtime.logout()}>
          Отменить подключение
        </button>
      )}
    </form>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.scss';

export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Error messages may contain request URLs with the token.
    console.error('Ошибка отображения', error.name, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className={styles.fatalError}>
          <h1>Не удалось открыть приложение</h1>
          <p>Сохранённая переписка остаётся в браузере. Попробуйте обновить страницу.</p>
          <button className={styles.reloadButton} onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}

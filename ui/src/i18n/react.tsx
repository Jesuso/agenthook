import { Fragment, createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { getLang, makeT, subscribeLang } from "./index";
import type { T } from "./index";

type I18n = { t: T; lang: string };

// Outside a provider (a component test, a lazy chunk mounted on its own) everything renders English.
const I18nContext = createContext<I18n>({ t: makeT("en"), lang: "en" });

/** Re-renders the tree under it when the language store changes (the reading panel), without a reload. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribeLang, getLang);
  const value = useMemo(() => ({ t: makeT(lang), lang }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `t` for the current language, and the language for the format.ts helpers' `lang` argument. */
export const useT = (): I18n => useContext(I18nContext);

/** A translated message with React nodes in its `{name}` placeholders (a `<code>` inside a sentence). */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/g).map((part, i) => <Fragment key={i}>{i % 2 ? (nodes[part] ?? `{${part}}`) : part}</Fragment>);
}

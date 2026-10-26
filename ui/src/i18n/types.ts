// The dictionary shapes (#561). A message is a string with `{name}` placeholders, or a set of plural
// forms picked by `Intl.PluralRules` from `vars.count` (`other` is the fallback for any category).

export type PluralForms = { one?: string; few?: string; many?: string; other: string };
export type Message = string | PluralForms;
export type Messages = Record<string, Message>;

/** `complete` is what Auto trusts: a language is offered by Auto only once every view is translated. */
export type DictionaryMeta = { lang: string; name: string; complete: boolean };

/** D1-D — ações que o menu nativo pode pedir ao renderer (allowlist; o mesmo nome é validado nos dois lados). */
export const MENU_ACTIONS = ['import', 'migrate', 'export-workspace', 'settings'] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];
export const isMenuAction = (v: unknown): v is MenuAction => typeof v === 'string' && (MENU_ACTIONS as readonly string[]).includes(v);

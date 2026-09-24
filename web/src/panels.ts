const storageKey = 'cidr.panel-preferences.v1';
const names = ['operations', 'visualization', 'ranges'] as const;
type PanelName = typeof names[number];

/** Store display preferences only; editor contents remain in memory. */
export function initializePanels(): (name: PanelName) => void {
  const panels = names.map((name) => ({
    name, element: document.querySelector<HTMLDetailsElement>(`#${name}-details`)!,
  }));
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const { name, element } of panels) {
        if (Object.hasOwn(saved, name)) element.open = Reflect.get(saved, name) === true;
      }
    }
  } catch { /* Storage may be disabled or contain invalid JSON. */ }

  const save = (): void => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(
        panels.map(({ name, element }) => [name, element.open]),
      )));
    } catch { /* Folding still works when preferences cannot be saved. */ }
  };
  for (const { element } of panels) element.addEventListener('toggle', save);

  return (name) => { panels.find((panel) => panel.name === name)!.element.open = true; };
}

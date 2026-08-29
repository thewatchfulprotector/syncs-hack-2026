/** Joins truthy class names — the tiny `cn` the ui components expect. */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(" ");
}

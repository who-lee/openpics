/**
 * The error every edit operation raises for a caller mistake.
 *
 * This lives alone in its own module because every other file in the editor needs
 * it and none of them need each other. It was defined in `session.ts`, which meant
 * `transform.ts` had to import `session.ts` purely to throw, while `session.ts`
 * imports `transform.ts` to render - a cycle that works only because the class
 * happens to be defined before first use, and that breaks the moment either file
 * grows an import that runs at module load. One file with no imports of its own
 * cannot be part of a cycle at all.
 */
export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

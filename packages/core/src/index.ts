/** Version of the `@ouaf/core` package. */
export const VERSION = '0.1.0'

// The engine validates every manifest before loading it; expose the same validator to hosts.
export { validateManifest, formatIssues, type Issue } from '@ouaf/spec'

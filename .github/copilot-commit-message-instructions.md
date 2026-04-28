When generating Git commit messages, strictly adhere to the following rules:

1. English must be used.
2. The format must be: `Type: Description`.
3. `Type` must be one of the following: `Added`, `Fixed`, `Optimised`, `Documentation`, or `Refactored`.
4. `Description` must be concise and clear, accurately reflecting the core value of the change.
5. Do not use multiple lines, do not include emojis, and do not add numbering or additional prefixes or suffixes.

Correct examples:

- `added: added user session timeout reminder`
- `fixed: resolved null pointer exception during bulk import`
- `optimised: reduced rendering time for the dashboard’s first screen`
- `documentation: added instructions for deployment environment variables`
- `refactored: split the audit module and standardised error handling`

---
name: code-review
description: Checklist and guidelines for reviewing code changes
alwaysLoad: false
---

# Code Review Guidelines

When reviewing code changes, work through this checklist systematically.

## Correctness
- Does the code do what it claims to do?
- Are edge cases handled (null, empty, boundary values)?
- Are error conditions caught and handled gracefully?

## Security
- Are user inputs validated and sanitized?
- Are secrets kept out of source code?
- Are permissions checked before actions?

## Style
- Does the code follow project conventions?
- Are names descriptive and consistent?
- Is there unnecessary complexity that could be simplified?

## Testing
- Are there tests for the new behavior?
- Do tests cover error and edge cases?
- Are tests readable and well-named?

## Performance
- Are there obvious N+1 queries or unnecessary loops?
- Is caching used appropriately?
- Are large payloads handled efficiently?

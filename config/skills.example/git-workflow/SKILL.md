---
name: git-workflow
description: Standard git branching, commit message, and PR workflow
---

# Git Workflow

Follow these conventions when working with git repositories.

## Branching

- Create feature branches from `main`: `feat/<short-description>`
- Use `fix/<short-description>` for bug fixes
- Use `chore/<short-description>` for maintenance tasks

## Commit Messages

Use conventional commit format:
- `feat: add user profile endpoint`
- `fix: handle null response in parser`
- `docs: update API reference`
- `chore: bump dependencies`
- `refactor: extract validation logic`

Keep the subject line under 72 characters. Add a blank line then a body for complex changes.

## Pull Requests

1. Push your branch and create a PR against `main`
2. Title should match the commit message format
3. Include a description of what changed and why
4. Reference any related issues: `Closes #123`
5. Request review from relevant team members

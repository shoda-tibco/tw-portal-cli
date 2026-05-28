# Repository Guidelines

## Project Structure & Module Organization

This repository is a Bun-powered TypeScript CLI for Transwestern charger availability and reservations. The executable entry point is `index.ts`

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run checkfix`: apply Biome fixes and fail on remaining warnings.
- `bun run typecheck`: run typchecking with `tsc` and fail on errors.
- `bun run cpd`: run dup code detection with `jscpd` and fail if duplicates are found.
- `bun run knip`: detect unused files, exports, and dependencies.
- `bun run all`: run `cpd`, `lint`, `knip`, and `typecheck` in parallel.

## Testing Guidelines

Before submitting changes, run `bun run all` and manually exercise affected CLI paths with `--dry-run` where reservations are involved. If adding tests, use Bun-friendly `*.test.ts` files, and add a `test` script to `package.json`.

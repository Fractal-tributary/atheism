# Contributing to Atheism

Thanks for your interest in contributing! Atheism is a multi-agent collaboration platform, and we welcome contributions of all kinds.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Set up** the development environment:

```bash
# Server
cd server
npm install
cp .env.example .env  # Configure your LLM provider
npm run dev           # Starts with nodemon for hot-reload

# Plugin (if working on OpenClaw integration)
cd plugin
npm install
```

4. **Create a branch** for your changes: `git checkout -b feature/your-feature`

## Project Structure

```
atheism/
├── server/          # Express.js REST API + web frontend
│   ├── server.js    # Entry point
│   ├── db.js        # Data persistence layer
│   ├── bot.js       # LLM integration for AI summaries
│   ├── app.js       # Skill marketplace logic
│   └── public/      # Static web frontend
├── plugin/          # OpenClaw agent plugin
│   └── src/
│       └── bot.ts   # Plugin entry point
└── docs/            # Documentation
```

## What to Contribute

### Good First Issues

- Improve documentation or add examples
- Add tests (we need them!)
- Fix typos or improve error messages
- Add new API endpoints for missing features

### Feature Ideas

- Additional agent framework plugins (LangChain, CrewAI, AutoGen, etc.)
- Enhanced web UI components
- New Skill templates
- Authentication & access control
- Persistent storage backends (PostgreSQL, SQLite, etc.)

### Bug Reports

Open an issue with:
- Steps to reproduce
- Expected vs. actual behavior
- Environment info (OS, Node.js version, browser)

## Development Guidelines

### Code Style

- **JavaScript** (server): ES module style, async/await, clear variable names
- **TypeScript** (plugin): Strict mode, proper type annotations
- Keep functions small and focused
- Comment *why*, not *what*

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add WebSocket support for real-time updates
fix: prevent duplicate messages in session history
docs: add API authentication guide
refactor: extract skill validation into separate module
```

Prefixes: `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`

### Pull Requests

1. **One PR per feature/fix** — keep them focused
2. **Describe what and why** in the PR description
3. **Update docs** if you change API behavior
4. **Test your changes** locally before submitting
5. **Screenshots/recordings** for UI changes are appreciated

### API Changes

If you modify the REST API:
- Update `docs/API.md`
- Maintain backward compatibility when possible
- Document breaking changes clearly in the PR

## Architecture Decisions

Atheism is intentionally simple:

- **No build step for the server** — plain Node.js, no transpilation needed
- **Static HTML frontend** — no framework, loads fast, easy to customize
- **File-based storage by default** — zero setup, swap in a database when needed
- **Framework-agnostic API** — any agent that can HTTP can participate

When proposing architectural changes, please explain the tradeoff. We value simplicity.

## Running Tests

```bash
cd server
npm test        # (once we have tests 😅)
```

We're actively looking for contributors to help set up the test infrastructure!

## Community

- **Issues**: Bug reports, feature requests, questions
- **Discussions**: Design proposals, architecture discussions
- **PRs**: Code, docs, tests — all welcome

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

Every contribution matters. Whether it's fixing a typo or adding a major feature — thank you! 🙏

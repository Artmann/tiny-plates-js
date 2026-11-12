- Use simple, non mannered language
- When creating pull requests, explain the problem you are solving and the changes at a high level. Include any relevant screenshots or videos. Highlight any manual steps that are still outstanding. You don't need to include information about the model or agent that wrote the code. You don't need to include information about the tests you wrote.
- Design for mobile first. Then use Tailwind modifiers to expand the design for larger devices and desktop.
- Use assertions like tiny-invariant to throw on invalid states.
- Don't worry if errors are pre-existing or not. Just fix them.

## Domain Driven Design

1. Ubiquitous language

The words used by the business should be the words used in your code. If the business says an invoice is settled, don't call the operation updateInvoiceStatus(). Call it settleInvoice().

2. Make invalid states difficult to represent

The domain model should enforce business rules rather than relying on every caller to remember them.
This doesn't require OOP encapsulation. Discriminated unions, branded types, schema validation, and pure functions can accomplish the same thing.

3. Model behavior, not just data

A domain model isn't simply a collection of TypeScript interfaces describing database records. It expresses what the business can do, which operations are legal, and how the system transitions between meaningful states.

4. Protect consistency boundaries

Aggregates are still a powerful concept, especially in concurrent and distributed systems. The important question isn't which objects belong inside a class. It's which business invariants must remain consistent within one transaction.

5. Separate domain decisions from technical orchestration

Business rules shouldn't depend on whether an operation was triggered by an HTTP request, a queue message, or a scheduled job. You don't necessarily need four architectural layers. You need a meaningful separation between business decisions and technical effects.

6. Discover abstractions instead of inventing them

The model should emerge from understanding the business. Don't create a generic `BaseEntity`, `AbstractRepository`, or  `DomainObject` just because a DDD diagram suggests one.

Prefer abstractions that express real domain distinctions.

7. Refactor when your understanding changes

The model is not a specification you finish before implementation. As you discover new business rules, the model should evolve. Renaming concepts, splitting responsibilities, and changing boundaries are part of the process.

8. Invest complexity where the business is complex

Not everything needs a rich domain model. A straightforward admin CRUD screen may be perfectly fine using simple data structures and database queries. DDD becomes valuable where business rules and concepts are genuinely complicated.

## Code Style

- Don't use CONSTANT_CASE. This is not JAVA.
- Use entire words as variable names. This is not Go. For example `request` instead of `req`.
- Use punctuation.
- Use whitespace to break up code to make it easier to read. Put a blank line after const groups and control flows and before return statements.
- Order things in alphabetical order by default. If applicable order by accessiblity level first, then alphabetical order.
- No any: Use proper types or unknown
- Prefer Nullish Coalescing: Use ?? over ||
- No Floating Promises: Always await or handle promises
- No Non-null Assertions: Avoid ! operator
- Single quotes
- No semicolons
- Always use bracers for control statements. 

## Memory

The services are long-running processes; small per-request retention becomes a
production leak. Rules for all TypeScript code:

- No unbounded module-level collections. Any module-scope `Map`, `Set`, array,
  or object that grows per request needs an eviction strategy (TTL, LRU, max
  size) — or should live per-request instead.
- Pair every acquire with a release in a `finally`: remove listeners, clear
  timers, close sockets, cursors, and sessions — including on the error path.
- Give every external await a timeout. Pass `AbortSignal.timeout(...)` to
  `fetch` and SDK calls so a hung call becomes a settled rejection instead of
  retained state (counters, Sets, closures) that never releases.
- Create per-request objects (DataLoaders, request contexts) per request. Never
  retain them at module scope.
- Create long-lived singletons (DB clients, runtimes) once at boot with bounded
  pools, and release them on shutdown.
- Bound what you accept and return: body-size limits, pagination caps, and
  projections that exclude large fields.


## Error handling

- Always handle errors.
- User facing errors should be easy to understand and actionable.
- Error messages must be **actionable** — tell the user what went wrong and what they can do about it
- When planning features, always consider what errors can occur and include the exact error messages in the plan

## Testing

- Put test files next to the implementation.
- Prefer `toEqual` over `toBe`
- Compare entire objects instead of single properties. `expect(product).toEqual({ id: 1, name: 'Cup' })`
- Use RTL to test React components.
- Unit test small, side effect free modules.
- We prefer "integration tests" that only mocks a small set of dependencies.
- Normally, we test the entire endpoint, using a mock database in esix. A good API test should perform a request and then assert that the correct documents have been created in the database.

## Git

- When using Conventional Commits, scopes should referer to a sub system or a part of the application. Something like "ui" is probably to generic.
- Don't use worktrees unless you are explicitly asked to do so.

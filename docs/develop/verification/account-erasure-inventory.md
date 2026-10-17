---
title: "Account erasure inventory"
summary: "The closed list of what account deletion erases, purges, compacts or retains, and the populated proofs that hold it."
read_when:
  - "you add a table, file or holder that stores an account's data"
audience:
  - developer
checked: none
---

The inventory is a closed list of storage consequences, independent of cleanup
code. `src/lib/auth/account-erasure-inventory.json` maps live schema tables,
source storage locations and retained holders to explicit erase, whole-purge,
shared-store compaction or retention rules. Every non-retention rule requires a
populated fixture. The declaration itself is not evidence that cleanup works.

`test-support/account-erasure-discovery.ts` discovers tables and account foreign
keys from an opened, migrated SQLite store. It enumerates every accounts column
separately, so extending that table requires an explicit profile-erasure decision;
only `id`, `status` and `sql_name` can be retained in the completed identity. The
original-account adoption marker has its own retention rule. References are
classified as owner, member, historical actor, SQL home or adoption. Historical
actors are not ownership predicates.

The source scan uses TypeScript syntax and symbol binding. It follows imported
accessor aliases, local variables, path joins, returned paths and writer wrappers
across files. Concrete path roots are checked as well as source identities. A new
writer in an existing directory cannot hide behind that directory's file rule.
It also finds singleton instances, class fields, factory closures, process holders
and weak collections. Request-local, browser-local and immutable literal
configuration are classified separately. Escaping closures are conservatively
inventoried even when their lifetime is a request; their retention rules identify
that scope and its drain requirement. This is source discovery, not a heap scan.

`test-support/account-erasure-file-fixture.ts` plants an independent file ledger.
Directory discovery checks those actual files, including the open database's WAL
and shared-memory files, against the file rules in both directions. The ledger is
not generated from the inventory. New locations fail; an inventory store without
a populated file fails too. The fixture includes retired/staged datasets, export
scratch, both thumbnail themes, manifests, input evidence and all three provider
answer caches, alongside independent controls and instance configuration.

The normal suite seeds an added table, an aliased accessor/writer, a factory
collection, a weak collection, a singleton class, a process holder, a stale
inventory entry, an unclassified account foreign key, a new retained-identity
column and a changed file location. Each is rejected independently. Forward
coverage and reverse existence are both required.

## Populated cleanup proofs

`proveErasure` in `test-support/account-erasure-proof.ts` is the completion oracle
for cleanup fixtures. A fixture binds each non-retained inventory store by its
exact identifier and supplies `populate`, `observe` and `dispose`. `observe` reads
actual retained entries, rows or file bytes independently of the cleanup service's
captured inventory and reported counts.

Before invoking cleanup, the oracle requires every binding, a nonempty target and
a nonempty control. Afterwards, the target must be absent and the control must be
unchanged. A whole-purge rule instead requires both cache populations to disappear
and a separately identified control outside that cache to survive unchanged.
Compaction probes observe live bytes, including former values, rather than row
counts. Account-profile probes distinguish erased fields from the deliberately
retained identity. Fixtures dispose in reverse order even when a check fails.

Partial cleanup stages use an explicit subinventory. A complete cleanup proof must
pass the full inventory; missing fixtures, empty stores and a list of classified
rules cannot yield a green completion claim. Each independent retained holder has
its own obligation even where several holders share one cleanup operation. File
accessors refer to the underlying file store's obligation.

The proof-oracle suite exercises actual scratch SQLite preferences, file bytes and
retained collections, with seeded retained targets, changed controls, incomplete
whole-cache purges and empty fixtures. Those tests establish the oracle's refusal
mechanism. They do not claim that the account cleanup implementation has erased
all stores; each cleanup delivery must bind and run its product-store fixtures.

Run the discovery and proof-oracle suites without a listener:

```sh
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/erasure-inventory-XXXXXX") \
  npx vitest run src/lib/auth/account-erasure-inventory.test.ts \
    src/lib/auth/account-erasure-proof.test.ts
```

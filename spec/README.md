# spec/

`openapi.json` is the OpenAPI document this SDK was written from — the snapshot
of the NowTempMail Developer API that `src/` and `README.md` describe.

It is **fetched, not hand-written**: `npm run spec:vendor` pulls it from
<https://nowtempmail.com/v1/openapi.json>, the same public unauthenticated
document any caller can GET, and pretty-prints it so changes review cleanly.
Never edit it by hand — a hand-edited snapshot makes drift detection meaningless.

`npm run spec:drift` compares this file's operation set against the live
document and fails if the two have diverged.

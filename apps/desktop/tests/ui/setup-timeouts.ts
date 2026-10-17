import { configure } from '@testing-library/react';

// Testing Library's waitFor and findBy* give up after 1 s by default. They return the moment their
// condition holds, so a longer limit costs nothing when the machine is quiet and only ends a wait that
// can never succeed. A busy machine (a full test run, a coverage build, another agent) can take
// several seconds to render once, which 1 s turned into a failure.
configure({ asyncUtilTimeout: 10_000 });

import { configure } from '@testing-library/react';

// A page's first render in a test file loads its modules; on a busy machine, as when the whole
// monorepo's tests run at once, that can take past Testing Library's default of one second.
configure({ asyncUtilTimeout: 5000 });

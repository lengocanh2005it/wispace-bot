# Token-bound reschedule confirmation and lazy expiry

**Status:** accepted

A staged reschedule may be committed only by a platform button carrying its one-time approval token or by `xác nhận <token>`, `đồng ý <token>`, or the token alone; bare filler or affirmative words never authorize a calendar write. Proposals are scoped to the current platform identity, and a newer proposal supersedes the older token. A stop request removes only a pending staged reschedule; once the request is claimed for the calendar write, it cannot be undone. If delivery of the proposal fails, the staged request is removed because the learner could not have seen its token. Expired proposals are reported on the next related interaction instead of generating a background message, keeping irreversible writes explicit without adding an expiry dispatcher.

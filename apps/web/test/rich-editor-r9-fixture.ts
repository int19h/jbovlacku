import { EditorView } from "prosemirror-view";
import type { Transaction } from "prosemirror-state";

/** Observe public dispatch calls, including calls from a recreated editor view. */
export function installRichEditorR9Trace() {
  const fixture = window as any;
  fixture.r9Events = [];
  fixture.r9Emissions = [];
  fixture.r9Transactions = [];
  const dispatch = EditorView.prototype.dispatch;
  EditorView.prototype.dispatch = function (transaction: Transaction) {
    fixture.r9View = this;
    const record = {
      composition: transaction.getMeta("composition") ?? null,
      explicit: transaction.getMeta("richExplicit") ?? false,
      changed: transaction.docChanged,
      before: transaction.before.toJSON(),
      proposed: transaction.doc.toJSON(),
      after: null as unknown,
    };
    dispatch.call(this, transaction);
    // A recovery can dispatch again through a new view during this call.
    record.after = fixture.r9View.state.doc.toJSON();
    fixture.r9Transactions.push(record);
  };
}

"""The server half of the table-insertion contract: the operations the browser sends (tests_ts/table_insert.test.ts proves it sends exactly
these) must leave the blocks where the caret was, survive a save and reload, and undo in one step."""
import json
import unittest
from pathlib import Path

from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "table_insert_contract.json").read_text(encoding="utf-8"))


class TableInsertContract(Workbench):
    def session_with(self, blocks):
        session = self.new_session()
        section = session.doc["blocks"][0].get("section")
        session.doc["blocks"][:] = [({**b, "section": section} if section and "section" not in b else dict(b)) for b in blocks]
        return session

    def test_every_scenario_lands_where_the_caret_was_and_undoes_in_one_step(self):
        for scenario in FIXTURE["scenarios"]:
            with self.subTest(scenario["name"]):
                session = self.session_with(scenario["blocks"])
                before = [(b["id"], b["text"]) for b in session.doc["blocks"]]
                for op in scenario["ops"]:
                    session.apply(op, None)
                self.assertEqual([b["id"] for b in session.doc["blocks"]], scenario["order"])
                by_id = {b["id"]: b for b in session.doc["blocks"]}
                for block_id, text in scenario.get("texts", {}).items():
                    self.assertEqual(by_id[block_id]["text"], text)
                saved = sldc().loads_package(session.to_bytes()).document["blocks"]
                self.assertEqual([b["id"] for b in saved], scenario["order"])
                session.undo(None)
                self.assertEqual([(b["id"], b["text"]) for b in session.doc["blocks"]], before)

    def test_a_typed_table_keeps_its_header_and_has_a_row_to_type_in(self):
        scenario = next(s for s in FIXTURE["scenarios"] if s["name"].startswith("Enter at the end of a delimiter line"))
        session = self.session_with(scenario["blocks"])
        for op in scenario["ops"]:
            session.apply(op, None)
        table = next(b for b in session.doc["blocks"] if b["type"] == "table")["table"]
        self.assertEqual(table["header_rows"], 1)
        self.assertEqual([[c["text"] for c in row] for row in table["rows"]], [["Name", "Qty"], ["", ""]])


if __name__ == "__main__":
    unittest.main()

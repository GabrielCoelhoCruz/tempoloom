"""Tests for the test() call reader in scripts/build-parity.py (scan, test_calls,
file_test_calls). Run: python3 -m unittest discover -s scripts -p "test_*.py"
"""
import importlib.util, os, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("build_parity", os.path.join(HERE, "build-parity.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


def calls(src):
    """{title: normalized body} for a file whose titles are unique."""
    out = {}
    for title, hits in bp.test_calls(src).items():
        assert len(hits) == 1, title
        out[title] = hits[0][1]
    return out


def norm(call):
    """The normalized body of call (its text up to the closing parenthesis)."""
    return "\n".join(l.strip() for l in call.strip().removesuffix(";").splitlines() if l.strip())


class Forms(unittest.TestCase):
    def test_forms_used_in_tests_e2e(self):
        a = 'test("a P1 task", async ({ page, cal, signIn }) => {\n  await page.goto("/");\n});'
        b = 'test("with a fixture object", async ({ page }) => {\n  expect(1).toBe(1);\n});'
        src = (
            'import { test, expect } from "./fixtures";\n'
            'test.skip(BACKEND === "google", "Uses several CalDAV users.");\n'
            'test.setTimeout(120_000);\n'
            f"{a}\n\n  {b}\n"
        )
        self.assertEqual(calls(src), {"a P1 task": norm(a), "with a fixture object": norm(b)})
        self.assertEqual(bp.test_calls(src)["with a fixture object"][0][0], 8)

    def test_multi_line_call(self):
        call = 'test(\n  "multi line",\n  async ({ page }) => {\n    await f(\n      1,\n    );\n  },\n);'
        self.assertEqual(calls(f"const x = 1;\n{call}\n"), {"multi line": norm(call)})

    def test_escaped_quote_in_title(self):
        self.assertEqual(list(calls('test("say \\"hi\\"", () => {});')), ['say "hi"'])

    def test_indent_and_blank_lines_do_not_count(self):
        a = calls('test("t", () => {\n  f();\n\n  g();\n});')
        b = calls('    test("t", () => {\n        f();\n        g();\n    });')
        self.assertEqual(a, b)

    def test_method_named_test_is_not_a_call(self):
        src = 'const ok = /x/.test("x") && re.test("y");\ntest("real", () => {});'
        self.assertEqual(list(calls(src)), ["real"])


class Braces(unittest.TestCase):
    def check(self, inner):
        call = f'test("t", () => {{\n{inner}\n}});'
        self.assertEqual(calls(f"{call}\nconst after = 1;\n"), {"t": norm(call)})

    def test_in_strings(self):
        self.check("const a = \"}) {\"; const b = ')}]'; const c = \"\\\" }\";")

    def test_in_templates(self):
        self.check("const a = `}) ${b ? `${c}}` : '}'} )`;\nconst d = `\\` }`;")

    def test_in_regex(self):
        self.check("const r = /[})]\\/}/g; const s = x.replace(/\\)/, \"\");\nreturn /}/.test(y);")

    def test_in_comments(self):
        self.check("// }) {\n/* ) } ]\n */ f();")

    def test_division_is_not_a_regex(self):
        self.check("const a = (b) / 2 / (c); const d = e[0] / f / g;")


class CrashForms(unittest.TestCase):
    """Forms that crashed the reader in PR #34 with a traceback that named no file."""

    def check(self, inner):
        call = f'test("t", () => {{\n{inner}\n}});'
        self.assertEqual(calls(f"{call}\nconst after = 1;\n"), {"t": norm(call)})

    def test_regex_after_if_head(self):
        self.check("if (ok) /}/.test(s);\nwhile (x) /[)]/.exec(s);")

    def test_division_after_postfix_increment(self):
        self.check("let i = 1; const h = i++ / 2; const k = (i-- / 2) / 1;\nx = i++ / (n - 1) + \")\".length;")

    def test_commented_out_test_call(self):
        src = (
            '// test("old", () => {\n'
            '/* test("older", () => { */\n'
            'const s = \'test("in a string", () => {\';\n'
            'test("t", () => {});\n'
        )
        self.assertEqual(calls(src), {"t": 'test("t", () => {})'})

    def test_line_comment_at_end_of_file(self):
        self.check("// a comment on the last line, with no newline after it")
        self.assertEqual(calls('test("t", () => {});\n// last line'), {"t": 'test("t", () => {})'})


class ParseErrors(unittest.TestCase):
    def test_error_names_file_and_line(self):
        src = 'const a = 1;\n\ntest("t", () => {\n  f(;\n'
        with self.assertRaises(SystemExit) as e:
            bp.file_test_calls("tests/e2e/x.spec.ts", src)
        self.assertIn("tests/e2e/x.spec.ts:", str(e.exception.code))
        self.assertIn("cannot read the test() calls", str(e.exception.code))

    def test_error_line(self):
        cases = {
            'f();\nconst s = "no end\n': 2,
            "f();\nf();\nconst t = `no end": 3,
            "f();\n/* no end": 2,
            "f();\nconst r = /no end\n": 2,
            "f(\n);\n)": 3,
            "f();\ntest(\"t\", () => {\n": 2,
        }
        for src, line in cases.items():
            with self.subTest(src=src):
                with self.assertRaises(SystemExit) as e:
                    bp.file_test_calls("tests/e2e/x.spec.ts", src)
                self.assertTrue(str(e.exception.code).startswith(f"tests/e2e/x.spec.ts:{line}: "), e.exception.code)


if __name__ == "__main__":
    unittest.main()

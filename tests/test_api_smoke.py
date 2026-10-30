from .api_helpers import ApiCase


class Smoke(ApiCase):
    def test_bootstrap_and_new_document(self):
        boot = self.web.ok("GET", "/api/bootstrap")
        self.assertEqual(boot["app"]["name"], "Writer")
        self.assertIsNone(boot["account"])
        state = self.new_doc("Hello")
        self.assertEqual(state["title"], "Hello")
        self.assertTrue((self.docs / "Hello.sldc").is_file())

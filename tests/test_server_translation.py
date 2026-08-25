import unittest
from types import SimpleNamespace

from server import translate_text_for_api


class FakeTranslator:
    instances = []

    def __init__(self, **options):
        self.options = options
        self.calls = []
        self.__class__.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        return False

    async def translate(self, text, **options):
        self.calls.append((text, options))
        return SimpleNamespace(
            text="Este texto deve estar em português.",
            src="en",
            dest="pt",
        )


class FailingTranslator(FakeTranslator):
    async def translate(self, text, **options):
        raise RuntimeError("upstream unavailable")


class ServerTranslationTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_gtx_and_raises_on_upstream_http_errors(self):
        FakeTranslator.instances.clear()

        result = await translate_text_for_api(
            "This text should be in Portuguese.",
            "pt",
            translator_factory=FakeTranslator,
        )

        translator = FakeTranslator.instances[-1]
        self.assertEqual(translator.options["service_urls"], ["translate.googleapis.com"])
        self.assertTrue(translator.options["raise_exception"])
        self.assertEqual(
            translator.calls,
            [("This text should be in Portuguese.", {"src": "auto", "dest": "pt"})],
        )
        self.assertEqual(result, {
            "translatedText": "Este texto deve estar em português.",
            "detectedSource": "en",
            "target": "pt",
        })

    async def test_does_not_turn_an_upstream_failure_into_english_success(self):
        with self.assertRaisesRegex(RuntimeError, "upstream unavailable"):
            await translate_text_for_api(
                "This must not be returned as a successful translation.",
                "pt",
                translator_factory=FailingTranslator,
            )


if __name__ == "__main__":
    unittest.main()

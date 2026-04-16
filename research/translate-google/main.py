import asyncio
from googletrans import Translator

async def translate_text():
    async with Translator() as translator:
        p = "Assyriologists have generally thought that the tablets from the end of the fourth millennium were a true writing; Bottéro claims that they are still part of the archaic stage of pictograms and are thus no more than memory-aids:"
        result = await translator.translate(p, dest="pt")

        js = "Os assiriologistas geralmente pensavam que as tabuinhas do final do quarto milênio eram uma escrita verdadeira; Bottéro afirma que eles ainda fazem parte da fase arcaica dos pictogramas e, portanto, nada mais são do que auxiliares de memória:"

        print(result.text == js)



asyncio.run(translate_text())

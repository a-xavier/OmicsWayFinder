
import {type VariantFile  } from '../biotypes'
 // @ts-ignore
 import Aioli from "@biowasm/aioli"
 import validateVariantFileFromText from './validateVariantFileFromText'


// each validate file will take only one file as input
export default async function validateVariant(file: File, setProcessing: (value: boolean) => void): Promise<{isValid: boolean, result: VariantFile}> {
   setProcessing(true);

    const CLI = await new Aioli(["bcftools/1.10"])
    const path = await CLI.mount(file);
    // bcftools 1.10 does not have the head command
    const header = await CLI.exec(`bcftools view -h ${path[0]}`);
    
    // Get firs 64kb of file directly, use bytes and then use 
    const chunk = await file.slice(0, 65536).bytes();
    await CLI.fs.writeFile("/tmp/chunk.bcf", chunk);

    const body = await CLI.exec("bcftools", [
    "view",
    "--no-header",
    "/tmp/chunk.bcf"
    ]);

    const result =  await validateVariantFileFromText(header, body, file.name)
    setProcessing(false);

    // Return dummy result for now
   return {
    isValid: result.isValid,
    result: result.result
   }
}

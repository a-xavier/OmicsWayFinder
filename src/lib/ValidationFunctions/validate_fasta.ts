import type { FastaFile } from "../biotypes";
 // @ts-ignore
 import Aioli from "@biowasm/aioli"
import validateFastaFile from './validateFastaFile'

export default async function validateFasta(file: File, setProcessing: (value: boolean) => void): Promise<{isValid: boolean, result: FastaFile}> {
    setProcessing(true);
    const CLI = await new Aioli(["seqtk/1.4"])
    const path = await CLI.mount(file);
    // use two commands 
    // comp to get list of sequnce names and length
    const compOutput = await CLI.exec(`seqtk comp ${path[0]}`);

    // const compOutput = ""; // Debug

    const result = await validateFastaFile(compOutput, file);
    setProcessing(false);
    return { isValid: result.isValid, result: result.result };
}
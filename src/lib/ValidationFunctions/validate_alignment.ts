 // main file to validate sam cram bam 

 import {type AlignmentFile } from '../biotypes'
 // @ts-ignore
 import Aioli from "@biowasm/aioli"
 import { validateAlignmentFileFromText } from './validateAlignmentFileFromText'

 export default async function validateAlignment(file: File, setProcessing: (value: boolean) => void): Promise<{isValid: boolean, result: AlignmentFile}> {
    setProcessing(true);
    const CLI = await new Aioli(["samtools/1.21"])
    const path = await CLI.mount(file);
    const header = await CLI.exec(`samtools view -H ${path[0]}`);
    const body = await CLI.exec(`samtools head -h 0 -n 100 ${path[0]}`);
    const validationResult = await validateAlignmentFileFromText(header, body, file.name);    
    setProcessing(false);

    return {
        isValid: validationResult.isValid,
        result: validationResult.alignmentFile
    }
 }
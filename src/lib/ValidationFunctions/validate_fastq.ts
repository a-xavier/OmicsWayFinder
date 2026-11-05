import { validateFastqFromArrayBuffer } from './validateFastqFileFrommArrayBuffer'
import {type FastqFile  } from '../biotypes'

// each validate file will take only one file as input
export default async function validateFastq(file: File, setProcessing: (value: boolean) => void): Promise<{isValid: boolean, result: FastqFile}> {
    setProcessing(true);
    // get first 1mb or the entire file if smaller
    const chunkSize = Math.min(file.size, 1024 * 1024); // 1 MB
    const arrayBuffer = await file.slice(0, chunkSize).arrayBuffer();
    const result = await validateFastqFromArrayBuffer(arrayBuffer, file.name);
    setProcessing(false);

   return {
    isValid: result?.isValid ?? false,
    result: result?.fastqFile ?? null
   }
}

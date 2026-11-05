import { type IdatFile } from '../biotypes'
import validateIdatFromArrayBuffer from './validateIdatFileFromArrayBuffer'
export default async function validateIdat(file: File, setProcessing: (value: boolean) => void): Promise<{isValid: boolean, result: IdatFile}> {
  setProcessing(true);

  // Implement IDAT validation logic here
  const { isValid, idatFile: result } = await validateIdatFromArrayBuffer(await file.arrayBuffer(), file.name);
  console.log(isValid, result)
  setProcessing(false);
  return { isValid, result };
}


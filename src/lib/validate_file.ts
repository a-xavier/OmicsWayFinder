// THis is the MAIN function to validate a file
// It takes a file as input and that is it 
// it routes it to the validator based on file extension 
import { type BioFile } from './biotypes'
import type { NotifyFunction } from './types'


// Each validator 
import validateFastq from './ValidationFunctions/validate_fastq'
import validateAlignment from './ValidationFunctions/validate_alignment'
import validatePod5 from './ValidationFunctions/validate_pod5'
import validateVariant from './ValidationFunctions/validate_variant'
import validateIdat from './ValidationFunctions/validate_idat'

export const validExtensions = [
    // ALignment
    'sam', 'bam', 'cram',
    //  Variant files 
    'vcf', 'bcf', "vcf.gz",
    // Array files
    'idat', 'cel',
    // Nanopore files
    'pod5',
    // Fastq 
    'fastq', 'fq', 'fastq.gz', 'fq.gz',
    // Other files
    'fasta', 'fa', 'fna', 'fasta.gz', 'fa.gz', 'fna.gz',

]
export async function validateFile(file: File, notify: NotifyFunction, setProcessing: (value: boolean) => void): Promise<BioFile> {

   if (validExtensions.some(ext => file.name.endsWith(ext))) {
       // Valid extension
   } else {
       notify("Unsupported file extension", "error");
   }

   // do Cases 
   let valid = false;
   let resultBiofile;

   switch (true) {
    case file.name.endsWith('.sam') || file.name.endsWith('.bam') || file.name.endsWith('.cram'):
        ({ isValid: valid, result: resultBiofile } = await validateAlignment(file, setProcessing))
        break;
    case file.name.endsWith('.vcf') || file.name.endsWith('.bcf') || file.name.endsWith('.vcf.gz') || file.name.endsWith('.vcf.bgz'):
        ({ isValid: valid, result: resultBiofile } = await validateVariant(file, setProcessing))
        break;
    case file.name.endsWith('.idat'):
        ({ isValid: valid, result: resultBiofile } = await validateIdat(file, setProcessing))
        break;
    case file.name.endsWith('.pod5'):
        ({ isValid: valid, result: resultBiofile } = await validatePod5(file, setProcessing));
        break;
    case file.name.endsWith('.fastq') || file.name.endsWith('.fq') || file.name.endsWith('.fastq.gz') || file.name.endsWith('.fq.gz'):
        ({ isValid: valid, result: resultBiofile } = await validateFastq(file, setProcessing))
        break;
    // TODO: Make fasta validation
    // case file.name.endsWith('.fasta') || file.name.endsWith('.fa') || file.name.endsWith('.fna') || file.name.endsWith('.fasta.gz') || file.name.endsWith('.fa.gz') || file.name.endsWith('.fna.gz'):
    //     // Handle fasta files
    //     break;
   }

    // Preserve the validator result's correlated kind and format.
    return {
        ...(resultBiofile ?? { kind: "UNKNOWN" as const, format: "UNKNOWN" as const }),
        id: crypto.randomUUID(),
        input:  {
                source: "FILE",
                file: file,
                size: file.size 
                },
        validity: valid ? "VALID" : "INVALID",
        invalidReason: valid ? "" : "invalid extension",
    }
}

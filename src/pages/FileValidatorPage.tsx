
import { useState } from 'react'
import Dropzone from '../components/Dropzone'
import PCSpec_detector from '../components/PCSpec_detector'
import FileValidator from '../components/FileValidator'
export default function FileValidatorPage() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])

  const onFilesSelected = (files: File[]) => {
    setSelectedFiles(files)
  }

  const clearSelectedFiles = () => {
    setSelectedFiles([])
  }

  return (
    <div>
    <p><strong>Omicswayfinder Prototype</strong></p>
      <Dropzone onFilesSelected={onFilesSelected} multiple={false} files={selectedFiles} />
      <PCSpec_detector />
      <FileValidator files={selectedFiles} clearSelectedFiles={clearSelectedFiles}/>
    </div>
  )
}
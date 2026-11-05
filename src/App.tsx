import { useState } from 'react'
import './App.css'

import Dropzone from './components/Dropzone'
import PCSpec_detector from './components/PCSpec_detector'
import FileValidator from './components/FileValidator'

function App() {

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])

  const onFilesSelected = (files: File[]) => {
    setSelectedFiles(files)
  }

  const clearSelectedFiles = () => {
    setSelectedFiles([])
  }

  return (
    <>
      <p style={{ fontWeight: 'bold' }}>Omicswayfinder Prototype</p>
      <Dropzone onFilesSelected={onFilesSelected} multiple={false} files={selectedFiles} />
      <PCSpec_detector />
      <FileValidator files={selectedFiles} clearSelectedFiles={clearSelectedFiles}/>
    </>
  )
}

export default App

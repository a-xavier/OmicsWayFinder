import { useState, useEffect } from 'react'
import './App.css'

import SamtoolsViewHeader from './components/SamtoolsViewHeader'
import Dropzone from './components/Dropzone'
import PipelineSelector from './components/PipelineSelector'
import  { sequencing_possibility_graph } from '../graphs.tsx'

function App() {

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])

  const onFilesSelected = (files: File[]) => {
    setSelectedFiles(files)
    console.log(files)
  }


  
  return (
    <>
      <p>Hello, Bioinformatics in the Browser!</p>
      <Dropzone onFilesSelected={onFilesSelected} multiple={false}/>
      <SamtoolsViewHeader file={selectedFiles[0] ?? null} />
      <PipelineSelector graph={sequencing_possibility_graph} />
    </>
  )
}

export default App

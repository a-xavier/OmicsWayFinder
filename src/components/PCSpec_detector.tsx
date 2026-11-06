import {useState, useEffect} from 'react'
import './PCSpec_detector.css'

export default function PCSpec_detector() {
    const [cpuCount, setCpuCount] = useState<number | null>(null)
    const [gpuPresent, setGpuPresent] = useState<boolean | null>(null)
    const [memoryTotal, setMemoryTotal] = useState<number | null>(null)
    const [arch, setArch] = useState<string | null>(null)
    const [platform, setPlatform] = useState<string | null>(null)
    const [browser, setBrowser] = useState<string | null>(null)

    const detectSpecs = async () => {
        setCpuCount(navigator.hardwareConcurrency || null)
        setMemoryTotal((navigator as any).deviceMemory || null)
        setPlatform(navigator.platform || null)
        const {arch: detectedArch, browser: detectedBrowser} = await getArchandBrowserfromUserAgent()
        setArch(detectedArch || null)
        setBrowser(detectedBrowser || null)
        // For gpu try requestAdapter()
        if (navigator.gpu) {
            navigator.gpu.requestAdapter().then(adapter => {
                setGpuPresent(!!adapter)
            }).catch(() => {
                setGpuPresent(false)
            })
        } else {
            setGpuPresent(false)
        }
    }

    useEffect(() => {
        detectSpecs()
    }, [])

  return (
    <div className="pcspec-detector">
    <p className="highlight"> Your PC Specs</p>
      <p><span className="highlight">CPU Count:</span> {cpuCount ?? 'Detecting...'}</p>
      <p><span className="highlight">GPU Present:</span> {gpuPresent === null ? 'Detecting...' : gpuPresent ? 'Yes' : 'No'}</p>
      <p><span className="highlight">Memory Total:</span> {memoryTotal ?? 'Detecting...'} GB</p>
      <p><span className="highlight">Architecture:</span> {arch ?? 'Detecting...'}</p>
      <p><span className="highlight">Platform:</span> {platform ?? 'Detecting...'}</p>
      <p><span className="highlight">Browser:</span> {browser ?? 'Detecting...'}</p>
        <p>Experimental - only works in chrome</p>
    </div>
  )
}

async function getArchandBrowserfromUserAgent(): Promise<{arch: string, browser: string}> {
    // @ts-ignore: navigator.userAgentData may not be available in all browsers
    const uaData = await  navigator.userAgentData.getHighEntropyValues(["architecture", "browser"])
    const arch = uaData.architecture || ''
    const browser = uaData.brands?.[uaData.brands.length - 1]?.brand || ''
    const browserVersion = uaData.brands?.[uaData.brands.length - 1]?.version || ''

    return {
      arch,
      browser: `${browser} ${browserVersion}`
    }
}

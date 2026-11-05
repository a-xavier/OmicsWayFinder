import './FileValidator.css'
import {useState, useEffect} from 'react'
import { validateFile } from '../lib/validate_file'
import { ToastContainer, toast } from 'react-toastify';
import type { BioFile } from '../lib/biotypes'



export default function FileValidator({ files, clearSelectedFiles }: { files: File[] | null, clearSelectedFiles: () => void }) {
    const [processing, setProcessing] = useState(false);
    const [validatedFiles, setValidatedFiles] = useState<BioFile[]>([]);
    
    const notify = (
        message: string,
        type: "info" | "success" | "warning" | "error" = "info"
    ) => {
        toast[type](message);
    };

    const validateFiles = () => {
        setValidatedFiles([]);
        if (files) {
            files.forEach(file => {
                validateFile(file, notify, setProcessing).then(validatedFile => {
                    setValidatedFiles(prev => [...prev, validatedFile]);
                })
            })
        }
    }
    

    useEffect(() => {
        validateFiles();
    }, [files]);

    return (
        <div className="file-validator" aria-busy={processing}>
            {processing && <p className="file-validator__processing" role="status">Processing...</p>}

            {!processing && files && files.length > 0 && (
                <div className="file-validator__actions">
                
                <button className="file-validator__clear" type="button" onClick={() => {
                    clearSelectedFiles();
                    setValidatedFiles([]);
                }}>Clear Files</button>
                </div>
            )}
          
            <ToastContainer />

            {validatedFiles.length > 0 && (
                <section className="file-validator__results" aria-label="Validated files">
                    <header className="file-validator__heading">
                        <h3>Validated Files</h3>
                        <span className="file-validator__count">{validatedFiles.length}</span>
                    </header>
                    <ul className="file-validator__list">
                        {validatedFiles.map(file => (
                            <li className="file-validator__file" key={file.id}>
                                <div className="file-validator__file-heading">
                                    <h4>{file.input.file.name}</h4>
                                    <span className="file-validator__validity" data-validity={file.validity}>
                                        {file.validity}
                                    </span>
                                </div>
                                <DisplayObject value={file} />
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    )
}

export function DisplayObject({ value }: { value: unknown }) {
    return (
        <div className="file-validator__object">
            <ObjectValue value={value} />
        </div>
    )
}

function ObjectValue({ value, ancestors = [] }: { value: unknown; ancestors?: object[] }) {
    const [expanded, setExpanded] = useState(ancestors.length > 0 && ancestors.length < 2);
    const [visibleCount, setVisibleCount] = useState(100);

    if (typeof File !== 'undefined' && value instanceof File) {
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        const unit = value.size === 0 ? 0 : Math.min(Math.floor(Math.log(value.size) / Math.log(1024)), units.length - 1);
        const size = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value.size / 1024 ** unit)} ${units[unit]}`;

        return (
            <div className="object-file">
                <div className="object-file__heading">
                    <span className="object-value__type">File</span>
                    <strong>{value.name}</strong>
                </div>
                <ObjectValue value={{
                    Size: `${size} (${value.size.toLocaleString()} bytes)`,
                    'MIME type': value.type || 'Not specified',
                    'Last modified': new Date(value.lastModified).toLocaleString(),
                }} />
            </div>
        )
    }

    if (value !== null && typeof value === 'object') {
        if (ancestors.includes(value)) {
            return <span className="object-value" data-type="null">Circular reference</span>
        }

        if (value instanceof Date) {
            return <span className="object-value" data-type="string">{value.toString()}</span>
        }

        const entries = Object.entries(value);
        const isArray = Array.isArray(value);
        const type = isArray ? 'Array' : 'Object';

        return (
            <details className="object-group" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
                <summary>
                    <span className="object-value__type">{type}</span>
                    <span className="object-group__count">
                        {entries.length} {isArray ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'field' : 'fields')}
                    </span>
                </summary>
                {expanded && (
                    <>
                        <dl className="object-table">
                            {entries.slice(0, visibleCount).map(([key, item]) => (
                                <div
                                    className={`object-table__row${item !== null && typeof item === 'object' && !(item instanceof Date) ? ' object-table__row--nested' : ''}`}
                                    key={key}
                                >
                                    <dt>{isArray ? `[${key}]` : key}</dt>
                                    <dd><ObjectValue value={item} ancestors={[...ancestors, value]} /></dd>
                                </div>
                            ))}
                        </dl>
                        {entries.length > visibleCount && (
                            <button className="file-validator__clear" type="button" onClick={() => setVisibleCount(count => count + 100)}>
                                Show more ({entries.length - visibleCount} remaining)
                            </button>
                        )}
                    </>
                )}
            </details>
        )
    }

    const type = value === null ? 'null'
        : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float')
        : typeof value;
    const text = value === '' ? 'Empty string' : String(value);

    return (
        <span className="object-value" data-type={type}>
            <span className="object-value__text">{text}</span>
            <span className="object-value__type">{type}</span>
        </span>
    )
}


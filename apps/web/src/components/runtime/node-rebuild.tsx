import { useState } from "react"
import { Hammer } from "lucide-react"
import { toast } from "sonner"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { LoadingButton } from "@/components/common/loading-button"
import { EmptyState } from "@/components/common/empty-state"

/** 节点重建：输入 nodeId，或从最近一次 revision 的节点里点选。 */
export function NodeRebuild({
  suggestions,
  rebuilding,
  onRebuild,
}: {
  suggestions: string[]
  rebuilding: boolean
  onRebuild: (nodeId: string) => void
}) {
  const [nodeId, setNodeId] = useState("")

  const submit = () => {
    const value = nodeId.trim()
    if (!value) {
      toast.error("请先填写节点 ID")
      return
    }
    onRebuild(value)
  }

  return (
    <div className="space-y-4">
      {suggestions.length === 0 ? (
        <EmptyState
          icon={Hammer}
          title="暂无可点选的节点"
          description="发布过一次之后，revision 里的节点会出现在这里；也可以直接输入节点 ID 重建。"
          compact
        />
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">从最近一次发布的节点中选择</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.slice(0, 24).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setNodeId(id)}
                className="max-w-full truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] transition-colors hover:border-primary/50 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                title={id}
              >
                {id}
              </button>
            ))}
          </div>
        </div>
      )}

      <Field>
        <FieldLabel htmlFor="rebuild-node-id">节点 ID</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="rebuild-node-id"
            value={nodeId}
            placeholder="例如 node_ab12cd34"
            autoComplete="off"
            className="font-mono text-xs sm:flex-1"
            onChange={(event) => setNodeId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit()
            }}
          />
          <LoadingButton loading={rebuilding} loadingText="重建中…" onClick={submit}>
            <Hammer data-icon="inline-start" />
            重建节点
          </LoadingButton>
        </div>
        <FieldDescription>
          重建会把该节点的 outbound 重新下发到数据面，用于修复「数据面缺失但库里存在」的节点；只影响这一个节点。
        </FieldDescription>
      </Field>
    </div>
  )
}

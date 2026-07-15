import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"
import { useI18n } from "@/i18n"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const { t } = useI18n()
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label={t('Loading', 'Wird geladen')} className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }

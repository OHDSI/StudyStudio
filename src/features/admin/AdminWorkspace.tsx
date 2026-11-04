import * as React from 'react'
import { FileOutput, Network, Stamp } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useStudyStore } from '@/store/useStudyStore'
import { ProtocolIssuer } from './ProtocolIssuer'
import { Aggregator } from './Aggregator'
import { ExportHub } from './ExportHub'

export function AdminWorkspace() {
  const [tab, setTab] = React.useState('protocol')
  const sites = useStudyStore((s) => s.sites.length)
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="protocol"><Stamp /> Protocol Issuer</TabsTrigger>
        <TabsTrigger value="aggregator"><Network /> Multi-Site Aggregator{sites ? ` (${sites})` : ''}</TabsTrigger>
        <TabsTrigger value="export"><FileOutput /> Export Hub</TabsTrigger>
      </TabsList>
      <TabsContent value="protocol"><ProtocolIssuer /></TabsContent>
      <TabsContent value="aggregator"><Aggregator /></TabsContent>
      <TabsContent value="export"><ExportHub /></TabsContent>
    </Tabs>
  )
}

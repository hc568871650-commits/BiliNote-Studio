import ProviderCard from '@/components/Form/DownloaderForm/providerCard.tsx'
import { videoPlatforms } from '@/constant/note.ts'

const Provider = () => {

  return (
    <section>
      <h2 className="settings-section-title">平台凭据</h2>
      <div className="settings-card">
        {videoPlatforms &&
          videoPlatforms.map((provider, index) => {
            if (provider.value !== 'local')
              return (
                <ProviderCard
                  key={index}
                  providerName={provider.label}
                  Icon={provider?.logo}
                  id={provider.value}
                />
              )
          })}
      </div>
    </section>
  )
}
export default Provider
